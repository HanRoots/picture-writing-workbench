import { makeCriteria } from './defaults.js';
import {
  ensureDistinctFeedback,
  isNonSemanticWriting,
  isPunctuationCriterion,
  makeInvalidWritingResult,
  punctuationEvidenceParts,
  uniqueFeedback,
} from './gradingGuards.js';

const FIRST_GRADE_POINTS = ['能写出画面中主要人物正在做什么'];

const SECOND_GRADE_POINTS = [
  '能写清画面中的主要人物、地点和事情',
  '多幅图或过程性画面能按画面顺序写清主要变化',
];

export async function demoAnalyze({ grade, imageCount, skipDelay = false }) {
  if (!skipDelay) await delay(700);
  const points = grade === 1
    ? FIRST_GRADE_POINTS
    : imageCount > 1 ? SECOND_GRADE_POINTS : SECOND_GRADE_POINTS.slice(0, 1);
  const requiredContent = imageCount > 1
    ? [grade === 2 ? '按画面顺序写清多幅图中主要事情的变化过程' : '按图片顺序写出主要事情']
    : [grade === 2 ? '用一句或几句把画面中的主要人物和事情写清楚' : '写出画面中的主要人物和主要事情'];
  const taskContract = {
    taskType: imageCount > 1 ? 'sequence' : 'single_sentence',
    givenContext: [],
    requiredContent,
    providedSupports: [],
    visibleFacts: [imageCount > 1 ? `共有 ${imageCount} 幅连续图片，需由老师确认人物、地点和事件变化` : '单幅图片中的人物、地点和动作需由老师确认'],
    imaginationSpace: ['可以根据画面适当补充人物的语言、动作或感受'],
    uncertainties: ['当前为演示识别结果，请老师核对题图'],
  };
  return {
    demo: true,
    taskContract,
    summary: imageCount > 1
      ? `这是一组按顺序展开的看图写话图片。请结合第 1 至第 ${imageCount} 幅图，确认主要人物、地点、动作及事情的先后变化。`
      : '这是一幅看图写话图片。请结合画面确认主要人物、地点、正在做的事情和直接可见的细节。',
    criteria: [
      ...points.map((text) => makeCriteria(text, 'basic', 'ai')),
      makeCriteria('如果原文有合理想象，能让画面内容更生动', 'bonus', 'ai'),
    ],
  };
}

export async function demoOcr() {
  await delay(650);
  return {
    demo: true,
    text: '小明和小红来到公园里。他们看见地上有许多落叶，就一起把落叶扫进簸箕里。公园变得干净了，他们很开心。',
    formatReview: { available: false, needsTeacherReview: false, notes: [] },
  };
}

function locate(text, snippet, type, reason, tone = 'issue') {
  const start = text.indexOf(snippet);
  if (start < 0 || !snippet) return null;
  return { id: crypto.randomUUID(), start, end: start + snippet.length, snippet, type, reason, tone };
}

export async function demoGrade({ text, criteria }) {
  await delay(1100);
  const clean = text.trim();
  if (isNonSemanticWriting(clean)) return { demo: true, ...makeInvalidWritingResult(clean, criteria) };
  const sentences = sentenceRecords(clean);
  const hasEndMark = /[。！？!?]$/.test(clean);
  const tooShort = clean.length < 18;
  const criterionResults = criteria.map((criterion) => {
    if (criterion.type === 'bonus') {
      const highlightEvidence = bonusEvidence(sentences);
      return {
        criterionId: criterion.id,
        status: highlightEvidence ? 'highlight' : 'not_shown',
        evidenceFound: Boolean(highlightEvidence),
        evidence: highlightEvidence || '',
        feedback: highlightEvidence ? '动作、感受或合理想象让画面更生动。' : '',
      };
    }
    const assessment = assessCriterion(criterion.text, clean, sentences, { hasEndMark, tooShort });
    return { criterionId: criterion.id, ...assessment };
  });
  const normalizedResults = ensureDistinctFeedback(criterionResults, criteria);
  const basics = normalizedResults.filter((item) => criteria.find((c) => c.id === item.criterionId)?.type === 'basic');
  const overall = basics.some((item) => item.status === 'unmet')
    ? '需要补充'
    : basics.some((item) => item.status === 'partial')
      ? '基本完成'
      : '完成得很好';
  const positives = [
    clean.length >= 18 && basics.some((item) => item.status === 'achieved') ? '写出了画面中的主要事情' : null,
    hasEndMark ? '注意到了句末标点' : null,
    sentences.length >= 2 ? '几句话能够前后连起来' : null,
  ].filter(Boolean).slice(0, 3);
  const priorities = uniqueFeedback(normalizedResults, criteria, 3);
  const annotations = [];
  const positiveEvidence = criterionResults.find((item) => item.status === 'achieved' && item.evidenceFound)?.evidence || '';
  const positiveLength = Math.min(8, positiveEvidence.length);
  if (positiveLength > 0) annotations.push(locate(clean, positiveEvidence.slice(0, positiveLength), '亮点', '这部分写出了画面中的内容。', 'positive'));
  if (!hasEndMark && clean.length) annotations.push(locate(clean, clean.slice(-1), '标点', '句子说完后缺少句末标点。'));
  const repeated = clean.match(/(.{1,3})\1/);
  if (repeated) annotations.push(locate(clean, repeated[0], '重复', '这里有重复的词语，只需保留一次。'));
  return {
    demo: true,
    overall,
    positives,
    priorities,
    criteria: normalizedResults,
    annotations: annotations.filter(Boolean),
  };
}

const PERSON_PATTERN = /小明|小红|小朋友|同学|老师|妈妈|爸爸|爷爷|奶奶|男孩|女孩|孩子|他们|她们|他|她/;
const ACTION_PATTERN = /来到|走|跑|看见|看到|看|拿|扫|捡|放|坐|站|说|笑|玩|做|帮助|浇|种|吃|喝|踢|跳|读|写|画|推|拉|搬|送|回/;
const LOCATION_PATTERN = /公园|教室|操场|学校|校园|家里|房间|河边|路上|树林|田野|草地|院子|地上|桌上|春天|夏天|秋天|冬天|阳光|天空|下雨|下雪/;
const DETAIL_PATTERN = /许多|一起|认真|轻轻|连忙|慢慢|高兴|开心|干净|漂亮|一边|一会儿|先|接着|然后|最后/;
const OBJECT_PATTERN = /落叶|树叶|花|树|小草|书|球|书包|雨伞|垃圾|桌子|椅子|动物|变得|干净|漂亮/;
const BONUS_PATTERN = /高兴|开心|难过|着急|连忙|认真|轻轻|心想|觉得|说[：:]|“|”/;

function sentenceRecords(text) {
  const records = [];
  const matcher = /[^。！？!?\n]+[。！？!?]?/g;
  let match;
  while ((match = matcher.exec(text))) {
    const leading = match[0].match(/^\s*/)?.[0].length || 0;
    const value = match[0].trim();
    if (!value) continue;
    const start = match.index + leading;
    records.push({ text: value, start, end: start + value.length });
  }
  return records;
}

function findSentence(sentences, pattern) {
  return sentences.find((item) => pattern.test(item.text)) || null;
}

function snippetAround(record, pattern, before = 5, after = 12) {
  if (!record) return '';
  const match = record.text.match(pattern);
  if (!match) return record.text;
  const start = Math.max(0, match.index - before);
  const end = Math.min(record.text.length, match.index + match[0].length + after);
  return record.text.slice(start, end).trim();
}

function assessCriterion(criterionText, clean, sentences, { hasEndMark, tooShort }) {
  const fallback = sentences[0]?.text || clean;
  if (isPunctuationCriterion(criterionText)) {
    const punctuated = punctuationEvidenceParts(clean, 1)[0];
    return punctuated
      ? achieved(punctuated)
      : result('unmet', fallback, '哪句话说完了，需要补上合适的句末标点？');
  }
  if (/通顺|前后意思|连贯/.test(criterionText)) {
    return achieved(clean.slice(0, Math.min(clean.length, 80)));
  }
  if (/顺序|先后|经过|变化过程/.test(criterionText)) {
    if (sentences.length < 2) return result('partial', '', '图中的事情先发生了什么，接着又发生了什么？', false);
    return achieved(clean.slice(sentences[0].start, sentences[Math.min(1, sentences.length - 1)].end));
  }
  if (/地点|环境|哪里|季节|天气/.test(criterionText)) {
    const record = findSentence(sentences, LOCATION_PATTERN);
    return record
      ? achieved(record.text.length <= 30 ? record.text : clauseAround(record, LOCATION_PATTERN))
      : result('partial', '', '再看看画面：事情发生在哪里，周围是什么样的？', false);
  }
  if (/细节|具体/.test(criterionText)) {
    const record = findSentence(sentences, DETAIL_PATTERN);
    return record
      ? achieved(clauseAround(record, DETAIL_PATTERN))
      : result('partial', '', '画面中有什么动作或样子可以再看仔细一些？', false);
  }
  if (/物品|变化|看到/.test(criterionText)) {
    const record = findSentence(sentences, OBJECT_PATTERN);
    return record
      ? achieved(clauseAround(record, OBJECT_PATTERN))
      : result('partial', '', '画面中还能直接看到什么物品或变化？', false);
  }
  if (/做什么|动作/.test(criterionText)) {
    const record = bestActionSentence(sentences);
    return record
      ? achieved(actionSnippet(record))
      : result('partial', '', '图中的主要人物正在做什么？', false);
  }
  if (/人物|谁/.test(criterionText)) {
    const record = findSentence(sentences, PERSON_PATTERN);
    return record
      ? achieved(snippetAround(record, PERSON_PATTERN, 0, 14))
      : result('partial', '', '图中都有谁？', false);
  }
  if (/完整的句子|完整的一句话|主要内容|主要意思|事情/.test(criterionText)) {
    const record = bestActionSentence(sentences) || sentences.reduce((longest, item) => item.text.length > (longest?.text.length || 0) ? item : longest, null);
    return tooShort
      ? result('partial', record?.text || fallback, '再看看画面：最主要的事情是什么？')
      : achieved(record?.text || fallback);
  }
  return tooShort
    ? result('partial', fallback, '再看看画面：还有哪一点可以写清楚？')
    : achieved(fallback);
}

function bestActionSentence(sentences) {
  return sentences.reduce((best, item) => {
    const score = (item.text.match(/来到|走|跑|看见|看到|看|拿|扫|捡|放|坐|站|说|笑|玩|做|帮助|浇|种|吃|喝|踢|跳|读|写|画|推|拉|搬|送|回/g) || []).length;
    if (!score) return best;
    if (!best || score > best.score || (score === best.score && item.text.length > best.record.text.length)) return { record: item, score };
    return best;
  }, null)?.record || null;
}

function actionSnippet(record) {
  const matches = [...record.text.matchAll(/来到|走|跑|看见|看到|看|拿|扫|捡|放|坐|站|说|笑|玩|做|帮助|浇|种|吃|喝|踢|跳|读|写|画|推|拉|搬|送|回/g)];
  const match = matches.at(-1);
  if (!match) return record.text;
  return clauseAround(record, { exec: () => match });
}

function bonusEvidence(sentences) {
  const record = findSentence(sentences, BONUS_PATTERN);
  return record ? clauseAround(record, BONUS_PATTERN) : '';
}

function clauseAround(record, pattern) {
  const match = pattern.exec(record.text);
  if (!match) return record.text;
  let start = match.index;
  while (start > 0 && !/[，,；;。！？!?]/.test(record.text[start - 1])) start -= 1;
  let end = match.index + match[0].length;
  while (end < record.text.length && !/[，,；;。！？!?]/.test(record.text[end])) end += 1;
  if (end < record.text.length && /[。！？!?]/.test(record.text[end])) end += 1;
  return record.text.slice(start, end).trim();
}

function achieved(evidence) {
  return result('achieved', evidence, '', Boolean(evidence));
}

function result(status, evidence, feedback, evidenceFound = Boolean(evidence)) {
  return { status, evidenceFound, evidence: evidenceFound ? evidence : '', feedback };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
