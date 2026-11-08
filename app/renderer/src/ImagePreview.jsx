import { useEffect, useState } from 'react';
import { Modal } from './ui.jsx';

export function ImagePreview({ src, alt = 'Image', onOpen }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!/^data:image\/(?:png|jpe?g|gif|webp|bmp|svg\+xml|x-icon)[;,]/i.test(src ?? '')) return null;
  return <>
    {failed ? <span className="markdown-image-error" role="status">Could not load image: {alt}</span>
      : <button className="image-preview" title="View image" aria-label={`View image: ${alt}`} onClick={onOpen ?? (() => setOpen(true))}>
          <img src={src} alt={alt} onError={() => setFailed(true)} />
        </button>}
    {open && <Modal title={alt} width={1200} onClose={() => setOpen(false)}><div className="image-lightbox"><img src={src} alt={alt} /></div></Modal>}
  </>;
}
