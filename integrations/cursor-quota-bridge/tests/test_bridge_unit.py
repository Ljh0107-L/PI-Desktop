"""Offline regressions. Run ONLY in approved CI; never call a model or bind sockets."""
import copy
import io
import json
import queue
import socket
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from cursor2api import h2stream, openai_api, server
from cursor2api.pb import frame, msg
from cursor2api.session import Session


class UsageTests(unittest.TestCase):
    def turn(self, reported=True, **usage):
        return SimpleNamespace(
            usage=usage, text_so_far="answer" * 100, thinking_so_far="reason" * 50,
            tool_text="tool", session=SimpleNamespace(
                usage_reported=reported, input_estimate=15000,
                previous_input_estimate=14000, tool_round=True, tool_result_estimate=1000))

    def test_reported_zero_cache_and_output_are_authoritative(self):
        u = server.usage_of(self.turn(input_tokens=100, output_tokens=0,
                                      cache_read_input_tokens=0))
        self.assertEqual(u["input_tokens"], 100)
        self.assertEqual(u["output_tokens"], 0)
        self.assertEqual(u["cache_read_input_tokens"], 0)
        self.assertEqual(u["cursor2api"]["source"], "upstream")

    def test_reported_zero_input_is_not_replaced(self):
        u = server.usage_of(self.turn(input_tokens=0, output_tokens=0))
        self.assertEqual(u["input_tokens"], 0)
        self.assertEqual(u["output_tokens"], 0)

    def test_cache_is_subset_and_counters_nonnegative(self):
        u = server.usage_of(self.turn(input_tokens=100, output_tokens=4,
            cache_read_input_tokens=80, cache_creation_input_tokens=40))
        self.assertEqual((u["input_tokens"], u["cache_read_input_tokens"],
                          u["cache_creation_input_tokens"]), (0, 80, 20))
        u = server.usage_of(self.turn(input_tokens=-1, output_tokens=-5,
                                      cache_read_input_tokens=100))
        self.assertEqual(u["input_tokens"], 0)
        self.assertEqual(u["output_tokens"], 0)
        self.assertEqual(u["cache_read_input_tokens"], 0)

    def test_tool_call_estimates_never_invent_cache(self):
        u = server.usage_of(self.turn(False))
        self.assertEqual(u["input_tokens"], 15000)
        self.assertEqual(u["cache_read_input_tokens"], 0)
        self.assertEqual(u["cursor2api"], {"source": "estimated", "cache": "unknown"})
        self.assertGreater(u["output_tokens"], 0)

    def test_openai_preserves_provenance_and_reasoning(self):
        u = server.usage_of(self.turn(input_tokens=100, output_tokens=10,
                                      reasoning_tokens=4, cache_read_input_tokens=75))
        out = openai_api.usage(u)
        self.assertEqual(out["prompt_tokens"], 100)
        self.assertEqual(out["total_tokens"], 110)
        self.assertEqual(out["completion_tokens_details"]["reasoning_tokens"], 4)
        self.assertEqual(out["cursor2api"], u["cursor2api"])


class SessionTests(unittest.TestCase):
    def session_with_events(self, events):
        s = Session()
        q = queue.Queue()
        for event in events:
            q.put(event)
        s.conn = SimpleNamespace(events=q)
        return s

    def test_transport_termination_is_not_success(self):
        for kind in ("end", "closed", "error"):
            with self.subTest(kind=kind):
                s = self.session_with_events([(kind, "reset")])
                self.assertEqual(list(s.events())[0][0], "error")

    def test_turn_ended_preserves_zero_usage(self):
        s = self.session_with_events([("data", frame(msg(f1=msg(f14=msg(f1=0, f2=0)))))])
        events = list(s.events())
        self.assertTrue(s.usage_reported)
        self.assertEqual(events[-1], ("end", "turn_ended"))
        self.assertEqual(s.usage["output_tokens"], 0)

    def test_clean_connect_trailer_and_error_trailer(self):
        for trailer, expected in (({}, "end"), ({"error": {"code": "internal"}}, "error"),
                                  ([], "error")):
            with self.subTest(trailer=trailer):
                s = self.session_with_events([("data", frame(json.dumps(trailer).encode(), 2))])
                self.assertEqual(list(s.events())[0][0], expected)
        s = self.session_with_events([("data", frame(b"broken", 2))])
        self.assertEqual(list(s.events())[0][0], "error")

    def test_hard_deadline_is_error(self):
        self.assertEqual(list(self.session_with_events([]).events(hard_timeout=0))[0][0], "error")

    def test_idle_timeout_is_error(self):
        s = self.session_with_events([])
        s.conn.events = Mock()
        s.conn.events.get.side_effect = queue.Empty
        with patch.object(s, "_idle_over", return_value=True):
            self.assertEqual(list(s.events())[0][0], "error")

    def test_unexpected_queue_failure_is_not_hidden(self):
        s = self.session_with_events([])
        s.conn.events = Mock()
        s.conn.events.get.side_effect = RuntimeError("queue broken")
        with self.assertRaises(RuntimeError):
            list(s.events())

    def test_request_history_is_not_mutated_and_no_fixed_overhead(self):
        tools = [{"name": "read", "input_schema": {"type": "object"}}]
        history = [{"role": "assistant", "content": [
            {"type": "tool-call", "toolName": "read", "toolCallId": "t", "args": {}}]}]
        before = copy.deepcopy(history)
        s = Session(tools=tools)
        s._run_request("hello", root_messages=history)
        self.assertEqual(history, before)
        self.assertLess(s.input_estimate, 12000)

    def test_same_prompt_does_not_share_hidden_state(self):
        messages = [{"role": "user", "content": "hello"}]
        self.assertNotEqual(server.conversation_id("system", messages, "model"),
                            server.conversation_id("system", messages, "model"))

    def test_assistant_string_history_is_preserved(self):
        root, *_ = server.build_history([
            {"role": "assistant", "content": "previous answer"},
            {"role": "user", "content": "continue"}])
        self.assertEqual(root[0]["content"], [{"type": "text", "text": "previous answer"}])

    def test_required_arguments_block_lossy_builtin_translation(self):
        s = Session(tools=[{"name": "read", "input_schema": {
            "type": "object", "properties": {"path": {"type": "string"}},
            "required": ["path", "offset", "limit"]}}])
        self.assertIsNone(s._translate_builtin({7}, msg(f7=msg(f1="/file"))))
        s.tool_by_name["read"]["input_schema"]["required"] = ["path"]
        self.assertEqual(s._translate_builtin({7}, msg(f7=msg(f1="/file"))),
                         ("read", {"path": "/file"}))

    def test_binary_write_never_reaches_client(self):
        s = Session(tools=[{"name": "write", "input_schema": {"type": "object"}}])
        self.assertIsNone(s._translate_builtin({3}, msg(f3=msg(f1="/user/file", f5=b"\xff\xfe"))))
        self.assertIsNone(s._translate_builtin({3}, msg(f3=msg(f1="/user/file", f2=b"\xff\xfe"))))
        self.assertEqual(s._translate_builtin({3}, msg(f3=msg(f1="/user/file", f2=b""))),
                         ("write", {"path": "/user/file", "content": ""}))

    def test_unknown_mcp_tool_is_refused(self):
        s = Session(tools=[{"name": "read"}])
        with patch.object(s, "send_tool_results") as reply:
            events = s._handle(msg(f2=msg(f1=2, f11=msg(f1="undeclared", f3="t"))))
        self.assertFalse(any(kind == "tool_use" for kind, _ in events))
        self.assertTrue(reply.call_args.args[0][0][-1])

    def test_start_rejects_existing_connection_before_auth(self):
        s = self.session_with_events([])
        with patch("cursor2api.session.access_token") as auth:
            with self.assertRaises(RuntimeError):
                s.start("hello")
        auth.assert_not_called()


class H2Tests(unittest.TestCase):
    def connection(self):
        c = object.__new__(h2stream.BidiH2)
        c.closed = False
        c.events = queue.Queue()
        c.window = threading.Condition()
        c.lock = threading.Lock()
        c.sock = Mock()
        return c

    def test_socket_eof_marks_closed_and_notifies(self):
        c = self.connection()
        c.sock.recv.return_value = b""
        c._read_loop()
        self.assertTrue(c.closed)
        self.assertEqual(c.events.get_nowait(), ("closed", None))

    def test_socket_read_timeout_does_not_abort_long_reasoning(self):
        c = self.connection()
        c.sock.recv.side_effect = [socket.timeout(), b""]
        c._read_loop()
        self.assertEqual(c.sock.recv.call_count, 2)
        self.assertEqual(c.events.get_nowait()[0], "closed")

    def test_send_stall_has_bounded_deadline(self):
        c = self.connection()
        c.stream_id = 1
        c.conn = Mock()
        c.conn.local_flow_control_window.return_value = 0
        c.conn.max_outbound_frame_size = 16384
        with patch("cursor2api.h2stream.time.monotonic", side_effect=[0, 31]):
            with self.assertRaises(TimeoutError):
                c.send(b"payload")


class HTTPTests(unittest.TestCase):
    def handler(self):
        h = object.__new__(server.Handler)
        h.wfile = io.BytesIO()
        h.send_response = Mock()
        h.send_header = Mock()
        h.end_headers = Mock()
        return h

    def test_sse_start_failure_is_terminal_without_success_stop(self):
        for method in ("_stream_turn", "_stream_turn_openai"):
            with self.subTest(method=method):
                h = self.handler()
                t = SimpleNamespace(model_in="test", start=Mock(side_effect=RuntimeError("failed")))
                with patch("traceback.print_exc"):
                    getattr(h, method)(t)
                wire = h.wfile.getvalue()
                self.assertTrue(wire.endswith(b"0\r\n\r\n"))
                self.assertIn(b'"error"', wire)
                self.assertNotIn(b"message_stop", wire)
                self.assertNotIn(b"[DONE]", wire)

    def test_sse_midstream_failure_terminates_both_formats(self):
        for method in ("_stream_turn", "_stream_turn_openai"):
            with self.subTest(method=method):
                h = self.handler()
                t = SimpleNamespace(model_in="test", start=Mock(),
                    stream=lambda: iter([("text", "partial"), ("error", "upstream reset")]))
                getattr(h, method)(t)
                wire = h.wfile.getvalue()
                self.assertTrue(wire.endswith(b"0\r\n\r\n"))
                self.assertIn(b'"error"', wire)
                self.assertNotIn(b"message_stop", wire)
                self.assertNotIn(b"[DONE]", wire)

    def test_sse_success_has_normal_terminal_event(self):
        for method, terminal in (("_stream_turn", b"message_stop"),
                                  ("_stream_turn_openai", b"[DONE]")):
            with self.subTest(method=method):
                h = self.handler()
                t = SimpleNamespace(model_in="test", start=Mock(), stop_reason=None,
                    stop_sequence=None, stream=lambda: iter([("text", "ok"), ("done", None)]))
                with patch.object(server, "usage_of", return_value={"input_tokens": 1,
                                                                       "output_tokens": 1}):
                    getattr(h, method)(t)
                wire = h.wfile.getvalue()
                self.assertTrue(wire.endswith(b"0\r\n\r\n"))
                self.assertIn(terminal, wire)

    def test_drain_admission_does_not_increment_active_count(self):
        with patch.object(server, "_DRAINING", True), patch.object(server, "_ACTIVE", 2):
            self.assertFalse(server._request_start())
            self.assertEqual(server._ACTIVE, 2)

    def test_login_requires_auth(self):
        h = self.handler()
        h.path = "/login"
        h._authed = lambda: False
        h._err = Mock()
        with patch.object(server, "start_background_login") as login:
            h.do_GET()
        login.assert_not_called()
        self.assertEqual(h._err.call_args.args[0], 401)

    def test_disallowed_model_never_starts(self):
        h = self.handler()
        h.path = "/v1/messages"
        h._authed = lambda: True
        h._body = lambda: {"messages": [{"role": "user", "content": "hello"}]}
        h._err = Mock()
        with patch.object(server, "Turn", return_value=SimpleNamespace(model="blocked")), \
             patch.object(server, "MODEL_ALLOW", ["allowed"]), \
             patch.object(server, "_request_start") as start:
            h.do_POST()
        start.assert_not_called()
        self.assertEqual(h._err.call_args.args[0], 403)

    def test_close_failure_still_releases_active_count(self):
        h = self.handler()
        h.path = "/v1/messages"
        h._authed = lambda: True
        h._body = lambda: {"messages": [{"role": "user", "content": "hello"}]}
        h._buffer_turn = Mock()
        t = SimpleNamespace(model="allowed", close=Mock(side_effect=RuntimeError("close failed")))
        with patch.object(server, "Turn", return_value=t), \
             patch.object(server, "MODEL_ALLOW", ["allowed"]), \
             patch.object(server, "_DRAINING", False), patch.object(server, "_ACTIVE", 0):
            with self.assertRaises(RuntimeError):
                h.do_POST()
            self.assertEqual(server._ACTIVE, 0)


if __name__ == "__main__":
    unittest.main()
