import Icon from './Icon.jsx';

export default function ToastStack({ items, dismiss }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone || 'success'}`}>
          <span className="toast-icon"><Icon name={item.tone === 'error' ? 'alert' : 'check'} size={17} /></span>
          <div>
            <strong>{item.title}</strong>
            {item.message && <p>{item.message}</p>}
          </div>
          <button className="icon-button compact" onClick={() => dismiss(item.id)} aria-label="关闭通知">
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
