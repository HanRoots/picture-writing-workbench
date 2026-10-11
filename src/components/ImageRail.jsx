import { useState } from 'react';
import Icon from './Icon.jsx';

export default function ImageRail({ images, onChange, compact = false }) {
  const [dragId, setDragId] = useState(null);

  function move(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const next = [...images];
    const from = next.findIndex((item) => item.id === fromId);
    const to = next.findIndex((item) => item.id === toId);
    if (from < 0 || to < 0) return;
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  }

  return (
    <div className={`image-rail ${compact ? 'compact' : ''}`}>
      {images.map((image, index) => (
        <div
          className={`image-tile ${dragId === image.id ? 'dragging' : ''}`}
          key={image.id}
          draggable
          onDragStart={() => setDragId(image.id)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => { move(dragId, image.id); setDragId(null); }}
          onDragEnd={() => setDragId(null)}
        >
          <img src={image.dataUrl} alt={`第 ${index + 1} 张图片`} />
          <span className="image-order">{index + 1}</span>
          <span className="drag-handle"><Icon name="grip" size={15} /></span>
          <button className="remove-image" onClick={() => onChange(images.filter((item) => item.id !== image.id))} aria-label={`删除第 ${index + 1} 张图片`}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
