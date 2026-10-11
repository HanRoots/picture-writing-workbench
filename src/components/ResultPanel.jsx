import Icon from './Icon.jsx';

const BASIC_STATUS = {
  achieved: ['已达成', 'success'],
  partial: ['部分达成', 'warning'],
  unmet: ['未达成', 'danger'],
  review: ['待核对', 'neutral'],
};

export default function ResultPanel({ task, submission, onRetry }) {
  if (!submission) return <PanelEmpty title="选择一份作品" text="左侧选择学生作品后，在这里查看批改结果。" />;
  if (submission.status === 'grading') {
    return (
      <div className="result-state">
        <span className="large-spinner" />
        <h2>正在批改这份作品</h2>
        <p>你可以继续添加或查看其他作品，批改不会中断。</p>
      </div>
    );
  }
  if (submission.status === 'failed') {
    return (
      <div className="result-state error-state">
        <span className="state-icon"><Icon name="alert" size={26} /></span>
        <h2>这次批改没有完成</h2>
        <p>{submission.error || '原文和图片都已保留，可以直接重试。'}</p>
        <button className="primary-button" onClick={onRetry}><Icon name="refresh" size={17} /> 重新批改</button>
      </div>
    );
  }
  if (submission.status === 'stale') {
    return (
      <div className="result-state warning-state">
        <span className="state-icon"><Icon name="refresh" size={26} /></span>
        <h2>结果需要更新</h2>
        <p>原文或任务评价标准已经改变，请重新批改。</p>
        <button className="primary-button" onClick={onRetry}>按当前内容重新批改</button>
      </div>
    );
  }
  if (!submission.result) return <PanelEmpty title="还没有批改结果" text="确认原文后即可开始批改。" />;

  const result = submission.result;
  const hasTeacherReviewItems = result.teacherReviewItems?.length > 0;
  const wordCorrections = (result.annotations || [])
    .filter((item) => item.type === '错别字' && !item.repeated && item.correction)
    .map((item) => `把“${item.snippet}”订正为“${item.correction}”。`)
    .filter((item, index, items) => items.indexOf(item) === index);
  const displayedPriorities = [...wordCorrections, ...(result.priorities || [])].slice(0, 3);
  const overallNote = {
    '完成得很好': '核心要求均已达成',
    '基本完成': hasTeacherReviewItems
      ? '主要内容已继续评价，另有个别表达需要老师核对'
      : '核心内容已经出现，还有部分表达可以补充',
    '需要补充': '还有题目明确要求的核心内容没有写出',
    '需要修改': '请先解决未达成的基本要求',
    '建议核对原文': '识别文字中有无法可靠判断的内容',
  }[result.overall] || '请结合逐项评价查看';
  return (
    <div className="result-content">
      <div className="result-overall">
        <p>整体结论</p>
        <h2 className={['需要补充', '需要修改'].includes(result.overall) ? 'needs-work' : result.overall === '建议核对原文' ? 'review-work' : ''}>{result.overall}</h2>
        <span>{overallNote}</span>
        <button className="text-button result-retry" onClick={onRetry}><Icon name="refresh" size={14} /> 重新批改</button>
      </div>

      {result.reviewRequired && (
        <div className="summary-block review-summary">
          <h3><span><Icon name="alert" size={16} /></span> 先核对识别原文</h3>
          <p>{result.reviewReason || '有部分文字无法可靠辨认，请对照作品图片核对后再判断。'}</p>
        </div>
      )}

      {!result.reviewRequired && hasTeacherReviewItems && (
        <div className="summary-block review-summary teacher-review-summary">
          <h3><span><Icon name="alert" size={16} /></span> 需要老师核对</h3>
          <ul>{result.teacherReviewItems.map((item, index) => (
            <li key={`${item.type}-${item.snippet}-${index}`}><strong>{item.type}</strong>：“{item.snippet}”——{item.reason}</li>
          ))}</ul>
          <p className="format-review-note">疑点已集中在这里，其余能够理解的内容已经继续批改。</p>
        </div>
      )}

      {submission.formatReview?.available && (
        <div className={`summary-block format-summary ${submission.formatReview.needsTeacherReview ? 'needs-review' : ''}`}>
          <h3><span><Icon name={submission.formatReview.needsTeacherReview ? 'alert' : 'check'} size={16} /></span> 书写格式观察</h3>
          {submission.formatReview.notes?.length
            ? <ul>{submission.formatReview.notes.map((item, index) => <li key={index}>{item}</li>)}</ul>
            : <p>方格和书写位置清楚可见，暂未发现需要特别核对的格式问题。</p>}
          <p className="format-review-note">这部分只供老师对照原图参考，不影响文字内容评价。</p>
        </div>
      )}

      <div className="summary-block positive-summary">
        <h3><span><Icon name="check" size={16} /></span> 做得好的地方</h3>
        {result.positives?.length ? <ul>{result.positives.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>暂未发现与评价要求直接相关的亮点。</p>}
      </div>
      <div className="summary-block priority-summary">
        <h3><span><Icon name="alert" size={16} /></span> 优先修改的地方</h3>
        {displayedPriorities.length ? <ol>{displayedPriorities.map((item, index) => <li key={index}>{item}</li>)}</ol> : <p>{result.reviewRequired ? '先核对识别原文，暂不向孩子提出修改要求。' : result.overall === '完成得很好' ? '基本要求均已达成，暂时没有优先修改项。' : '暂未生成优先修改建议。'}</p>}
      </div>

      <div className="criteria-result-section">
        <div className="result-section-title"><h3>逐项评价</h3><span>{task.criteria.length} 项</span></div>
        {task.criteria.map((criterion) => {
          const item = result.criteria?.find((candidate) => candidate.criterionId === criterion.id) || {};
          const evidenceParts = item.evidenceParts?.length ? item.evidenceParts : item.evidence ? [item.evidence] : [];
          const status = criterion.type === 'bonus'
            ? item.status === 'highlight' ? ['有亮点', 'success'] : ['未体现', 'neutral']
            : BASIC_STATUS[item.status] || ['未判断', 'neutral'];
          return (
            <article className="criterion-result" key={criterion.id}>
              <div className="criterion-result-head">
                <span className={`status-chip ${status[1]}`}>{status[0]}</span>
                <span className={`criterion-kind ${criterion.type}`}>{criterion.type === 'basic' ? '基本要求' : '加分表现'}</span>
              </div>
              <h4>{criterion.text}</h4>
              {item.evidenceFound ?? Boolean(item.evidence)
                ? <blockquote className={evidenceParts.length > 1 ? 'multiple-evidence' : ''}>{evidenceParts.map((part, index) => <span key={`${index}-${part}`}>“{part}”</span>)}</blockquote>
                : <p className="evidence-missing">{item.status === 'review' ? '这部分原文需要老师对照作品图片核对。' : '原文中暂未找到与这一评价点直接相关的内容。'}</p>}
              {item.feedback && <p className="criterion-feedback"><Icon name="chevronRight" size={15} /> {item.feedback}</p>}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function PanelEmpty({ title, text }) {
  return <div className="result-state"><span className="state-icon neutral"><Icon name="file" size={26} /></span><h2>{title}</h2><p>{text}</p></div>;
}
