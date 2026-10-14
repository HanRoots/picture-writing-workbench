import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import SubmissionComposer from './SubmissionComposer.jsx';
import AnnotatedText from './AnnotatedText.jsx';
import ResultPanel from './ResultPanel.jsx';
import { gradeWriting } from '../lib/api.js';
import { inferSecondGradeLevel, statusLabel } from '../lib/defaults.js';

const OCR_COPY_PROMPT = '请识别孩子手写的作文，只输出识别出的原文。绝对不要添加、删减或修改任何内容，不要提供批改意见。请忽略红笔文字，并按不同同学分别整理输出。';

export default function Workbench({ task, onChange, onBack, onSettings, notify }) {
  const [selectedId, setSelectedId] = useState(task.submissions?.[0]?.id || null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState('text');
  const [mobileTab, setMobileTab] = useState('source');
  const [editingText, setEditingText] = useState(false);
  const [draftText, setDraftText] = useState('');
  const selected = useMemo(() => task.submissions.find((item) => item.id === selectedId) || task.submissions[0] || null, [task.submissions, selectedId]);
  const secondGradeLevel = inferSecondGradeLevel(task.grade, task.taskContract);
  const secondGradeLevelLabel = task.taskContract?.requiredContent?.length
    ? (secondGradeLevel === 'developing' ? '进阶写话' : '起步写话')
    : '要求待确认';

  useEffect(() => {
    if (!selectedId && task.submissions[0]) setSelectedId(task.submissions[0].id);
  }, [selectedId, task.submissions]);

  function updateSubmission(id, update) {
    onChange((current) => ({
      ...current,
      submissions: current.submissions.map((item) => item.id === id ? { ...item, ...(typeof update === 'function' ? update(item) : update) } : item),
    }));
  }

  async function startGrading(submission) {
    updateSubmission(submission.id, { status: 'grading', error: '' });
    try {
      const result = await gradeWriting({
        grade: task.grade,
        summary: task.summary,
        taskContract: task.taskContract,
        criteria: task.criteria,
        text: submission.text,
        textConfirmed: submission.textConfirmed === true,
      });
      updateSubmission(submission.id, { status: 'completed', result, gradedAt: new Date().toISOString(), error: '' });
      notify(`${submission.name} 批改完成`, '结果已自动保存。');
    } catch (error) {
      updateSubmission(submission.id, { status: 'failed', error: error.message || '批改服务暂时不可用' });
      notify(`${submission.name} 批改失败`, '原文已保留，可以直接重试。', 'error');
    }
  }

  function addSubmission(submission) {
    onChange((current) => ({ ...current, submissions: [...current.submissions, submission] }));
    setSelectedId(submission.id);
    setComposerOpen(false);
    setMobileTab('result');
    startGrading(submission);
  }

  function retry() {
    if (selected) startGrading(selected);
  }

  function beginEditText() {
    if (!selected) return;
    setDraftText(selected.text);
    setEditingText(true);
  }

  function saveText() {
    const text = draftText.trim();
    if (!text || !selected) return;
    const changed = text !== selected.text;
    updateSubmission(selected.id, { text, status: changed && selected.status === 'completed' ? 'stale' : selected.status });
    setEditingText(false);
    if (changed) notify('原文已更新', '原批改结果已标记为需要重新批改。');
  }

  function renameSubmission() {
    if (!selected) return;
    const name = window.prompt('修改作品名称', selected.name)?.trim();
    if (name) updateSubmission(selected.id, { name });
  }

  function deleteSubmission() {
    if (!selected || !window.confirm(`确定永久删除“${selected.name}”吗？图片、原文和批改结果都会被删除。`)) return;
    const remaining = task.submissions.filter((item) => item.id !== selected.id);
    onChange({ ...task, submissions: remaining });
    setSelectedId(remaining[0]?.id || null);
  }

  async function copyOcrPrompt() {
    try {
      await navigator.clipboard.writeText(OCR_COPY_PROMPT);
    } catch {
      const copyField = document.createElement('textarea');
      copyField.value = OCR_COPY_PROMPT;
      copyField.setAttribute('readonly', '');
      copyField.style.position = 'fixed';
      copyField.style.opacity = '0';
      document.body.appendChild(copyField);
      copyField.select();
      const copied = document.execCommand('copy');
      copyField.remove();
      if (!copied) {
        notify('复制失败', '请选中提示语后手动复制。', 'error');
        return;
      }
    }
    notify('提示语已复制', '可以直接粘贴到其他文字识别工具中。');
  }

  return (
    <div className="workbench-page">
      <header className="topbar workbench-topbar">
        <button className="text-button back-button" onClick={onBack} aria-label="全部任务"><Icon name="arrowLeft" size={18} /><span className="button-label">全部任务</span></button>
        <div className="workbench-title">
          <h1>{task.name}</h1>
          <span>{task.grade === 1 ? '一年级' : `二年级 · ${secondGradeLevelLabel}`} · {task.criteria.filter((item) => item.type === 'basic').length} 条基本要求</span>
        </div>
        <button className="secondary-button small" onClick={onSettings} aria-label="任务设置"><Icon name="settings" size={17} /><span className="button-label">任务设置</span></button>
      </header>

      <section className="ocr-copy-banner" aria-label="手写作文识别提示语">
        <p>{OCR_COPY_PROMPT}</p>
        <div className="ocr-copy-actions">
          <a className="ocr-kimi-link" href="https://www.kimi.com/" target="_blank" rel="noopener noreferrer" aria-label="Kimi 官网（在新标签页打开）">Kimi 官网</a>
          <button className="ocr-copy-button" onClick={copyOcrPrompt}><Icon name="copy" size={16} /><span>复制提示语</span></button>
        </div>
      </section>

      <div className="mobile-work-tabs">
        <button className={mobileTab === 'source' ? 'active' : ''} onClick={() => setMobileTab('source')}>原文</button>
        <button className={mobileTab === 'result' ? 'active' : ''} onClick={() => setMobileTab('result')}>批改</button>
      </div>

      <main className="workbench-grid">
        <aside className="submission-sidebar">
          <div className="sidebar-heading"><span>学生作品</span><strong>{task.submissions.length}</strong></div>
          <button className="add-submission-button" onClick={() => setComposerOpen(true)}><Icon name="plus" size={17} /> 添加一份作品</button>
          <div className="submission-list">
            {task.submissions.map((submission, index) => (
              <button className={`submission-item ${selected?.id === submission.id ? 'active' : ''}`} key={submission.id} onClick={() => { setSelectedId(submission.id); setMobileTab('source'); }}>
                <span className="submission-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="submission-meta"><strong>{submission.name}</strong><small className={`submission-status ${submission.status}`}>{submission.status === 'grading' && <span className="mini-spinner" />}{statusLabel(submission.status)}</small></span>
                <Icon name="chevronRight" size={15} />
              </button>
            ))}
          </div>
          {!task.submissions.length && <p className="sidebar-empty">还没有作品。每次添加一份，确认原文后即可开始批改。</p>}
        </aside>

        <section className={`source-panel ${mobileTab === 'source' ? 'mobile-active' : ''}`}>
          <header className="panel-header">
            <div><p>学生原文</p><h2>{selected?.name || '尚未选择作品'}</h2></div>
            {selected && <div className="panel-actions"><button className="icon-button" onClick={renameSubmission} aria-label="重命名"><Icon name="edit" size={17} /></button><button className="icon-button danger-on-hover" onClick={deleteSubmission} aria-label="删除"><Icon name="trash" size={17} /></button></div>}
          </header>
          {selected ? (
            <>
              {selected.images?.length > 0 && (
                <div className="source-mode-tabs">
                  <button className={sourceMode === 'text' ? 'active' : ''} onClick={() => setSourceMode('text')}>原文</button>
                  <button className={sourceMode === 'image' ? 'active' : ''} onClick={() => setSourceMode('image')}>作品图片 · {selected.images.length}</button>
                </div>
              )}
              <div className="source-scroll">
                {sourceMode === 'image' && selected.images?.length ? (
                  <div className="source-images">{selected.images.map((image, index) => <figure key={image.id}><img src={image.dataUrl} alt={`${selected.name} 第 ${index + 1} 页`} /><figcaption>第 {index + 1} 页</figcaption></figure>)}</div>
                ) : editingText ? (
                  <div className="text-editor-pane"><textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} /><div><button className="secondary-button" onClick={() => setEditingText(false)}>取消</button><button className="primary-button" onClick={saveText}>保存原文</button></div></div>
                ) : (
                  <div className="paper-view">
                    <div className="paper-toolbar"><span>点击彩色下划线查看说明</span><button className="text-button" onClick={beginEditText}><Icon name="edit" size={15} /> 修改原文</button></div>
                    <AnnotatedText text={selected.text} annotations={selected.result?.annotations || []} />
                    <div className="annotation-legend"><span><i className="green" /> 亮点</span><span><i className="orange" /> 需要留意</span>{selected.result?.annotations?.some((item) => item.tone === 'neutral') && <span><i className="gray" /> 待老师核对</span>}</div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="panel-empty"><span><Icon name="file" size={28} /></span><h2>添加第一份学生作品</h2><p>支持上传手写图片识别，也可以直接输入文字。</p><button className="primary-button" onClick={() => setComposerOpen(true)}><Icon name="plus" size={17} /> 添加作品</button></div>
          )}
        </section>

        <aside className={`result-panel ${mobileTab === 'result' ? 'mobile-active' : ''}`}>
          <header className="panel-header result-panel-header"><div><p>AI 批改</p><h2>评价结果</h2></div>{selected?.status === 'completed' && <span className="saved-indicator"><Icon name="check" size={14} /> 已保存</span>}</header>
          <div className="result-scroll"><ResultPanel task={task} submission={selected} onRetry={retry} /></div>
        </aside>
      </main>

      {composerOpen && <SubmissionComposer sequence={task.submissions.length + 1} grade={task.grade} onClose={() => setComposerOpen(false)} onConfirm={addSubmission} notify={notify} />}
    </div>
  );
}
