#!/bin/sh
# Start a throwaway, unprivileged OpenSSH server on 127.0.0.1 for M0 verification.
# Uses its own host key, client key and known_hosts under $DIR; never touches ~/.ssh.
# Prints the ssh_config path and host alias, then runs sshd in the foreground (Ctrl-C to stop).
set -eu
DIR=${PIDESK_SSHD_DIR:-/tmp/pidesk-sshd}
PORT=${PIDESK_SSHD_PORT:-$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}
mkdir -p "$DIR"
[ -f "$DIR/host_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/host_ed25519"
[ -f "$DIR/client_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$DIR/client_ed25519"
cp "$DIR/client_ed25519.pub" "$DIR/authorized_keys"
chmod 600 "$DIR/authorized_keys"
cat > "$DIR/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $DIR/host_ed25519
AuthorizedKeysFile $DIR/authorized_keys
PidFile $DIR/sshd.pid
UsePAM no
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
Subsystem sftp internal-sftp
SetEnv PATH=$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin
EOF
cat > "$DIR/ssh_config" <<EOF
Host pidesk-test
  HostName 127.0.0.1
  Port $PORT
  User $(whoami)
  IdentityFile $DIR/client_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile $DIR/known_hosts
  StrictHostKeyChecking accept-new
  BatchMode yes
EOF
echo "ssh config: $DIR/ssh_config  host: pidesk-test  port: $PORT"
exec /usr/sbin/sshd -D -e -f "$DIR/sshd_config"
