import { useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { formatRelativeTime, taskState } from '../lib/defaults.js';

export default function TaskList({ tasks, onCreate, onOpen, onRename, onDelete }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => tasks
      .filter((task) => task.name.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
    [tasks, query],
  );

  return (
    <div className="page-shell task-list-page">
      <header className="topbar home-topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">写</span>
          <span>看图写话工作台</span>
        </a>
        <button className="primary-button" onClick={onCreate}>
          <Icon name="plus" size={18} /> 新建看图写话
        </button>
      </header>

      <main className="list-main">
        <div className="page-heading-row">
          <div>
            <p className="eyebrow">教师工作台</p>
            <h1>批改任务</h1>
            <p className="page-intro">为每一组题图建立评价标准，再逐份添加学生作品。</p>
          </div>
          <label className="search-box">
            <Icon name="search" size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务名称" />
          </label>
        </div>

        {filtered.length ? (
          <div className="task-table" role="list">
            <div className="task-table-head" aria-hidden="true">
              <span>任务</span><span>年级</span><span>批改进度</span><span>最近更新</span><span />
            </div>
            {filtered.map((task) => {
              const completed = (task.submissions || []).filter((item) => item.status === 'completed').length;
              const state = taskState(task);
              return (
                <article className="task-row" key={task.id} role="listitem" onClick={() => onOpen(task)}>
                  <div className="task-identity">
                    <div className="task-thumb">
                      {task.images?.[0] ? <img src={task.images[0].dataUrl} alt="题图缩略图" /> : <Icon name="image" size={22} />}
                    </div>
                    <div>
                      <h2>{task.name || '未命名任务'}</h2>
                      <span className={`status-chip ${state.tone}`}>{state.label}</span>
                    </div>
                  </div>
                  <span className="table-value">{task.grade === 1 ? '一年级' : '二年级'}</span>
                  <div className="progress-cell">
                    <strong>{completed}</strong><span> / {(task.submissions || []).length} 份</span>
                    <div className="progress-track"><i style={{ width: `${task.submissions?.length ? (completed / task.submissions.length) * 100 : 0}%` }} /></div>
                  </div>
                  <span className="muted table-value">{formatRelativeTime(task.updatedAt)}</span>
                  <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                    <button className="icon-button" onClick={() => onRename(task)} aria-label="重命名"><Icon name="edit" size={17} /></button>
                    <button className="icon-button danger-on-hover" onClick={() => onDelete(task)} aria-label="删除"><Icon name="trash" size={17} /></button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="empty-state">
            <div className="empty-illustration"><Icon name={query ? 'search' : 'file'} size={40} /></div>
            <h2>{query ? '没有找到相关任务' : '还没有看图写话任务'}</h2>
            <p>{query ? '试试其他任务名称。' : '先上传题图并确认评价点，再开始添加学生作品。'}</p>
            {!query && <button className="primary-button" onClick={onCreate}><Icon name="plus" size={18} /> 新建第一个任务</button>}
          </section>
        )}
      </main>
      <footer className="local-data-note">数据仅保存在当前浏览器中 · 清除浏览器数据后无法恢复</footer>
    </div>
  );
}
