import { useRef, useState } from 'react';
import Icon from './Icon.jsx';
import ImageRail from './ImageRail.jsx';
import { readFiles, uid } from '../lib/defaults.js';
import { recognizeText } from '../lib/api.js';

export default function SubmissionComposer({ sequence, grade, onClose, onConfirm, notify }) {
  const [mode, setMode] = useState('image');
  const [name, setName] = useState('');
  const [images, setImages] = useState([]);
  const [text, setText] = useState('');
  const [ocrState, setOcrState] = useState('idle');
  const [ocrReviewNote, setOcrReviewNote] = useState('');
  const [formatReview, setFormatReview] = useState({ available: false, needsTeacherReview: false, notes: [] });
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  async function addImages(event) {
    const available = Math.max(0, 12 - images.length);
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!available) {
      setError('每份作品最多保留 12 张图片');
      return;
    }
    const picked = await readFiles(files.slice(0, available));
    setImages((current) => [...current, ...picked]);
    setError(files.length > available ? '已保留前 12 张图片，其余图片未添加' : '');
  }

  async function runOcr() {
    if (!images.length) {
      setError('请先上传学生作品图片');
      return;
    }
    setOcrState('loading');
    setError('');
    try {
      const result = await recognizeText({ grade, images: images.map((item) => item.dataUrl) });
      setText(result.text || '');
      setOcrReviewNote(result.needsReview ? (result.reviewNote || '有部分手写内容无法可靠辨认，请对照原图核对后再批改。') : '');
      setFormatReview(result.formatReview || { available: false, needsTeacherReview: false, notes: [] });
      setOcrState('done');
      notify('文字识别完成', '请对照原图确认原文，AI 不会自动改写。');
    } catch (ocrError) {
      setOcrState('failed');
      setError(ocrError.message || '文字识别失败，图片已经保留');
    }
  }

  function submit() {
    if (!text.trim()) {
      setError(mode === 'image' ? '请先识别或手动输入原文，再确认批改' : '请输入学生原文');
      return;
    }
    onConfirm({
      id: uid('submission'),
      name: name.trim() || `作品 ${String(sequence).padStart(2, '0')}`,
      mode,
      images,
      text: text.trim(),
      formatReview,
      textConfirmed: true,
      status: 'grading',
      result: null,
      error: '',
      createdAt: new Date().toISOString(),
      gradedAt: null,
    });
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="composer-dialog" role="dialog" aria-modal="true" aria-labelledby="composer-title">
        <header className="dialog-header">
          <div><p className="eyebrow">添加一份作品</p><h2 id="composer-title">确认学生原文</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>
        <div className="composer-content">
          <label className="field-label">
            <span>作品名称 <small>选填</small></span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder={`留空则使用“作品 ${String(sequence).padStart(2, '0')}”`} />
          </label>

          <div className="mode-tabs" role="tablist">
            <button className={mode === 'image' ? 'active' : ''} onClick={() => setMode('image')}><Icon name="image" size={17} /> 图片识别</button>
            <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}><Icon name="text" size={17} /> 直接输入文字</button>
          </div>

          {mode === 'image' && (
            <div className="composer-image-area">
              {images.length > 0 && <ImageRail images={images} onChange={setImages} compact />}
              <div className="composer-image-actions">
                <button className="secondary-button" onClick={() => inputRef.current?.click()}><Icon name="upload" size={17} /> {images.length ? '继续添加图片' : '上传学生作品'}</button>
                <button className="primary-button subtle" disabled={!images.length || ocrState === 'loading'} onClick={runOcr}>
                  {ocrState === 'loading' ? <><span className="spinner light" /> 正在识别</> : <><Icon name="sparkle" size={17} /> 识别原文</>}
                </button>
              </div>
              <input hidden ref={inputRef} type="file" accept="image/*" multiple onChange={addImages} />
            </div>
          )}

          <label className="field-label original-text-field">
            <span>{mode === 'image' ? '识别出的原文' : '学生原文'} <em>必填</em></span>
            <textarea rows="9" value={text} onChange={(event) => setText(event.target.value)} placeholder={mode === 'image' ? '识别结果会出现在这里。无法识别的文字可由老师手动补录。' : '请按学生原文输入，不需要先改错。'} />
            {mode === 'image' && <small className="faithful-note">请对照图片确认。识别只负责转写，不自动修改错别字、语病或标点。</small>}
          </label>
          {mode === 'image' && ocrReviewNote && <div className="inline-alert warning compact-alert"><Icon name="alert" size={17} /><span><strong>需要人工核对：</strong>{ocrReviewNote}</span></div>}
          {mode === 'image' && formatReview.available && (
            <div className={`inline-alert compact-alert format-observation ${formatReview.needsTeacherReview ? 'warning' : ''}`}>
              <Icon name={formatReview.needsTeacherReview ? 'alert' : 'check'} size={17} />
              <span><strong>书写格式观察：</strong>{formatReview.notes?.length ? formatReview.notes.join('；') : '方格和书写位置清楚可见，暂未发现需要特别核对的格式问题。'}（仅供老师参考）</span>
            </div>
          )}
          {error && <div className="inline-alert error compact-alert"><Icon name="alert" size={17} /><span>{error}</span>{ocrState === 'failed' && <button onClick={runOcr}>重试</button>}</div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" onClick={submit}>确认原文并开始批改 <Icon name="chevronRight" size={17} /></button>
        </footer>
      </section>
    </div>
  );
}
