import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import ImageRail from './ImageRail.jsx';
import { analyzePicture } from '../lib/api.js';
import { baselineCriteria, inferSecondGradeLevel, makeCriteria, readFiles } from '../lib/defaults.js';
import {
  listToText,
  normalizeTaskContract,
  TASK_TYPE_OPTIONS,
  taskContractToSummary,
  textToList,
} from '../lib/taskContract.js';

export default function TaskEditor({ task, onChange, onBack, onFinish, notify }) {
  const [errors, setErrors] = useState({});
  const [standardsDirty, setStandardsDirty] = useState(false);
  const fileRef = useRef(null);
  const contract = normalizeTaskContract(task.taskContract, task.summary);
  const secondGradeLevel = inferSecondGradeLevel(task.grade, contract);
  const secondGradeLevelLabel = contract.requiredContent.length
    ? (secondGradeLevel === 'developing' ? '进阶写话' : '起步写话')
    : '待确认';

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  function save(patch, dirty = false) {
    if (dirty && task.standardsConfirmed) setStandardsDirty(true);
    onChange((current) => ({ ...current, ...patch }));
  }

  async function runAnalysis(nextImages = task.images, force = false) {
    if (!nextImages.length) return;
    if (force && task.criteria.some((item) => item.origin === 'ai' && item.teacherEdited)) {
      const approved = window.confirm('重新生成会替换你修改过的 AI 评价点；老师手动添加的评价点会保留。是否继续？');
      if (!approved) return;
    }
    save({ analysisState: 'loading', analysisError: '', analysisStale: false });
    try {
      const result = await analyzePicture({
        grade: task.grade,
        images: nextImages.map((item) => item.dataUrl),
        taskContract: force && task.taskContract ? contract : null,
        summary: force && !task.taskContract ? task.summary : '',
      });
      const preserved = task.criteria.filter((item) => item.origin === 'teacher');
      const aiCriteria = result.criteria.map((item) => ({
        ...item,
        id: item.id || crypto.randomUUID(),
        origin: 'ai',
        teacherEdited: false,
      }));
      save({
        summary: result.summary,
        taskContract: result.taskContract,
        criteria: [...baselineCriteria(task.grade, result.taskContract), ...preserved, ...aiCriteria],
        analysisState: 'done',
        analysisError: '',
        analysisStale: false,
      }, true);
      notify('题图分析完成', '请检查画面摘要和评价点。');
    } catch (error) {
      save({ analysisState: 'failed', analysisError: error.message || '题图分析失败' });
      notify('题图分析失败', '图片已保留，可以重试或手动填写。', 'error');
    }
  }

  async function addImages(event) {
    const available = Math.max(0, 8 - task.images.length);
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!available) {
      notify('题图数量已达上限', '每个任务最多保留 8 张题图。', 'error');
      return;
    }
    const picked = await readFiles(files.slice(0, available));
    if (files.length > available) notify('部分图片未添加', '每个任务最多保留 8 张题图。', 'error');
    if (!picked.length) return;
    const wasEmpty = task.images.length === 0;
    const images = [...task.images, ...picked];
    save({ images, analysisStale: !wasEmpty && task.analysisState === 'done' });
    if (wasEmpty) runAnalysis(images);
  }

  function updateImages(images) {
    save({ images, analysisStale: task.analysisState === 'done' });
  }

  function changeGrade(grade) {
    const custom = task.criteria.filter((item) => item.origin !== 'baseline');
    save({ grade, criteria: [...baselineCriteria(grade, contract), ...custom], analysisStale: task.images.length > 0 }, true);
  }

  function updateCriterion(id, patch) {
    save({
      criteria: task.criteria.map((item) => item.id === id
        ? { ...item, ...patch, teacherEdited: item.origin === 'ai' ? true : item.teacherEdited }
        : item),
    }, true);
  }

  function removeCriterion(id) {
    save({ criteria: task.criteria.filter((item) => item.id !== id) }, true);
  }

  function addCriterion() {
    save({ criteria: [...task.criteria, makeCriteria('', 'basic', 'teacher')] }, true);
  }

  function updateContract(patch) {
    const nextContract = normalizeTaskContract({ ...contract, ...patch });
    const currentLevel = inferSecondGradeLevel(task.grade, contract);
    const nextLevel = inferSecondGradeLevel(task.grade, nextContract);
    const contractPatch = { taskContract: nextContract, summary: taskContractToSummary(nextContract) };
    if (currentLevel !== nextLevel) {
      contractPatch.criteria = [
        ...baselineCriteria(task.grade, nextContract),
        ...task.criteria.filter((item) => item.origin !== 'baseline'),
      ];
    }
    save(contractPatch, true);
  }

  function confirmStandards() {
    const nextErrors = {};
    if (!task.name.trim()) nextErrors.name = '请填写任务名称';
    if (task.analysisStale) nextErrors.analysis = '题图已经变化，请先重新分析题图再保存评价标准';
    if (!contract.requiredContent.length) nextErrors.contract = '请先确认“孩子本次需要完成”的核心内容';
    if (!task.criteria.some((item) => item.text.trim() && item.type === 'basic')) nextErrors.criteria = '至少保留一条基本要求';
    if (task.criteria.some((item) => !item.text.trim())) nextErrors.criteria = '请补全或删除空白评价点';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    let nextTask = { ...task, name: task.name.trim(), standardsConfirmed: true };
    if (standardsDirty) {
      const affected = task.submissions.filter((item) => item.status === 'completed').length;
      if (affected) {
        const approved = window.confirm(`评价标准已经改变，${affected} 份已批改作品将标记为“需要重新批改”。是否保存？`);
        if (!approved) return;
        nextTask = {
          ...nextTask,
          submissions: task.submissions.map((item) => item.status === 'completed' ? { ...item, status: 'stale' } : item),
        };
      }
    }
    onFinish(nextTask);
  }

  return (
    <div className="page-shell editor-page">
      <header className="topbar editor-topbar">
        <button className="text-button back-button" onClick={onBack}><Icon name="arrowLeft" size={18} /> 返回任务</button>
        <div className="step-indicator"><i className="active" /><i className="active" /><i /></div>
        <span className="autosave-label"><Icon name="check" size={15} /> 已自动保存</span>
      </header>

      <main className="editor-main">
        <div className="editor-heading">
          <p className="eyebrow">{task.standardsConfirmed ? '任务设置' : '新建看图写话'}</p>
          <h1>{task.standardsConfirmed ? '修改任务与评价点' : '先让 AI 读懂题图'}</h1>
          <p>AI 会提出初步评价点，最终标准由老师确认，一次确认后用于本任务的所有作品。</p>
        </div>

        <section className="form-section">
          <div className="section-number">01</div>
          <div className="section-body">
            <div className="section-title-row">
              <div><h2>任务信息</h2><p>任务名称在开始批改前填写即可。</p></div>
            </div>
            <div className="two-column-fields">
              <label className="field-label">
                <span>任务名称 <em>必填</em></span>
                <input className={errors.name ? 'invalid' : ''} value={task.name} onChange={(event) => save({ name: event.target.value })} placeholder="例如：秋天的公园" />
                {errors.name && <small className="field-error">{errors.name}</small>}
              </label>
              <fieldset className="field-label grade-field">
                <legend>年级 <em>必选</em></legend>
                <div className="segmented-control">
                  <button className={task.grade === 1 ? 'selected' : ''} onClick={() => changeGrade(1)}>一年级</button>
                  <button className={task.grade === 2 ? 'selected' : ''} onClick={() => changeGrade(2)}>二年级</button>
                </div>
              </fieldset>
            </div>
          </div>
        </section>

        <section className="form-section">
          <div className="section-number">02</div>
          <div className="section-body">
            <div className="section-title-row">
              <div><h2>上传题图</h2><p>支持一张或多张；拖动图片可以调整阅读顺序。</p></div>
              {task.analysisStale && <span className="status-chip warning"><Icon name="alert" size={14} /> 题图有变化</span>}
            </div>
            {task.images.length > 0 && <ImageRail images={task.images} onChange={updateImages} />}
            <button className="upload-zone" onClick={() => fileRef.current?.click()}>
              <span className="upload-icon"><Icon name="upload" size={23} /></span>
              <span><strong>{task.images.length ? '继续添加题图' : '选择题图开始分析'}</strong><small>JPG、PNG、WEBP，可多选</small></span>
            </button>
            <input ref={fileRef} hidden type="file" accept="image/*" multiple onChange={addImages} />
            {task.analysisState === 'loading' && <div className="inline-state"><span className="spinner" /> AI 正在识别画面内容和题目要求…</div>}
            {task.analysisState === 'failed' && (
              <div className="inline-alert error"><Icon name="alert" size={18} /><span><strong>分析失败，图片已经保留。</strong>你可以重试，也可以直接手动填写下面的内容。</span><button onClick={() => runAnalysis()}>重新分析</button></div>
            )}
            {task.analysisStale && <button className="secondary-button analyze-again" onClick={() => runAnalysis(task.images, true)}><Icon name="refresh" size={17} /> 重新分析题图</button>}
            {errors.analysis && <p className="field-error standalone">{errors.analysis}</p>}
          </div>
        </section>

        <section className="form-section">
          <div className="section-number">03</div>
          <div className="section-body">
            <div className="section-title-row">
              <div><h2>任务边界确认</h2><p>先区分题目已给内容、本次任务、写话支架和可以自由想象的范围。</p></div>
              <button className="text-button" disabled={(!task.summary.trim() && !contract.requiredContent.length && !contract.providedSupports.length && !contract.visibleFacts.length) || task.analysisState === 'loading'} onClick={() => runAnalysis(task.images, true)}><Icon name="sparkle" size={16} /> 根据修改重新生成评价点</button>
            </div>
            <div className="contract-type-row">
              <label className="field-label">
                <span>题目类型</span>
                <select value={contract.taskType} onChange={(event) => updateContract({ taskType: event.target.value })}>
                  {TASK_TYPE_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              <p>
                题型只帮助 AI 判断重点，不会限制孩子必须使用某种写法。
                {task.grade === 2 && <><br /><strong>当前要求：{secondGradeLevelLabel}</strong><span>· {contract.requiredContent.length ? '系统根据题型、明确任务和写话支架自动判断' : '请先确认“孩子本次需要完成”'}</span></>}
              </p>
            </div>
            <div className="contract-editor-grid">
              <label className="contract-field context-field">
                <span>题目已经给出 <small>不要求孩子重复</small></span>
                <textarea rows="5" value={listToText(contract.givenContext)} onChange={(event) => updateContract({ givenContext: textToList(event.target.value) })} placeholder="例如：开头已经交代的人物、地点和事情起因；每行一项。" />
              </label>
              <label className="contract-field required-field">
                <span>孩子本次需要完成 <em>核心评价来源</em></span>
                <textarea rows="5" value={listToText(contract.requiredContent)} onChange={(event) => updateContract({ requiredContent: textToList(event.target.value) })} placeholder="例如：写出人物想出的办法；每行一项。" />
              </label>
              <label className="contract-field">
                <span>画面能够直接确认 <small>用于理解，不要求全部写出</small></span>
                <textarea rows="5" value={listToText(contract.visibleFacts)} onChange={(event) => updateContract({ visibleFacts: textToList(event.target.value) })} placeholder="只填写画面中能够确认的人物、动作、场景和顺序。" />
              </label>
              <label className="contract-field imagination-field">
                <span>允许自由想象 <small>没有唯一答案</small></span>
                <textarea rows="5" value={listToText(contract.imaginationSpace)} onChange={(event) => updateContract({ imaginationSpace: textToList(event.target.value) })} placeholder="例如：人物可能说什么、怎么想、接下来怎样发展。" />
              </label>
            </div>
            <label className="contract-field support-field">
              <span>题目提供的提示或支架 <small>帮助展开，不等于标准答案</small></span>
              <textarea rows="3" value={listToText(contract.providedSupports)} onChange={(event) => updateContract({ providedSupports: textToList(event.target.value) })} placeholder="例如：提示问题、关键词、表格栏目或可仿照的例句；每行一项。" />
            </label>
            <label className="contract-field uncertainty-field">
              <span>需要老师核对 <small>不确定内容不会直接进入评价点</small></span>
              <textarea rows="3" value={listToText(contract.uncertainties)} onChange={(event) => updateContract({ uncertainties: textToList(event.target.value) })} placeholder="没有不确定内容可以留空。" />
            </label>
            {errors.contract && <p className="field-error standalone">{errors.contract}</p>}
          </div>
        </section>

        <section className="form-section criteria-section">
          <div className="section-number">04</div>
          <div className="section-body">
            <div className="section-title-row">
              <div><h2>本次评价点</h2><p>基本要求决定整体结论；加分表现只记录亮点，不影响结论。</p></div>
              <button className="secondary-button small" onClick={addCriterion}><Icon name="plus" size={16} /> 添加评价点</button>
            </div>
            <div className="criteria-editor-list">
              {task.criteria.map((criterion, index) => (
                <div className="criterion-editor-row" key={criterion.id}>
                  <span className="drag-handle static"><Icon name="grip" size={16} /></span>
                  <span className="criterion-index">{String(index + 1).padStart(2, '0')}</span>
                  <textarea rows="2" value={criterion.text} onChange={(event) => updateCriterion(criterion.id, { text: event.target.value })} placeholder="用一句话写清判断标准" />
                  <select value={criterion.type} onChange={(event) => updateCriterion(criterion.id, { type: event.target.value })}>
                    <option value="basic">基本要求</option>
                    <option value="bonus">加分表现</option>
                  </select>
                  <button className="icon-button danger-on-hover" onClick={() => removeCriterion(criterion.id)} aria-label="删除评价点"><Icon name="trash" size={17} /></button>
                </div>
              ))}
            </div>
            {errors.criteria && <p className="field-error standalone">{errors.criteria}</p>}
            <p className="criteria-note"><Icon name="alert" size={15} /> 基本要求只应来自“孩子本次需要完成”；提示、例句和关键词是表达支架，不是固定答案或固定顺序。</p>
          </div>
        </section>
      </main>

      <div className="editor-footer">
        <div><strong>{task.criteria.filter((item) => item.type === 'basic').length}</strong> 条基本要求 · <strong>{task.criteria.filter((item) => item.type === 'bonus').length}</strong> 条加分表现</div>
        <button className="primary-button large" onClick={confirmStandards}>
          {task.standardsConfirmed ? '保存评价标准' : '确认评价点，开始添加学生作品'} <Icon name="chevronRight" size={18} />
        </button>
      </div>
    </div>
  );
}
