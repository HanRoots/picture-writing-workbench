const HAN_PATTERN = /\p{Script=Han}/u;
const LATIN_RUN_PATTERN = /\p{Script=Latin}+/gu;
const PINYIN_VOWEL_PATTERN = /[aeiouvüāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/iu;
const END_MARK_PATTERN = /[。！？!?]/;
const PUNCTUATION_CRITERION_PATTERN = /标点|句号|问号|感叹号/;

export function containsPinyinLike(text) {
  const runs = String(text || '').match(LATIN_RUN_PATTERN) || [];
  return runs.some((run) => PINYIN_VOWEL_PATTERN.test(run));
}

export function isPinyinFormCorrection({ snippet, type, reason }) {
  const explanation = String(reason || '');
  return containsPinyinLike(snippet)
    && (type === '错别字'
      || /拼音|声调|音节|改成?汉字|写成?汉字|代替汉字/.test(explanation)
      || /(?:应|应该|需要|建议|可以|可).{0,8}(?:写成|改成|改为|写作|写为|写[“"「])/.test(explanation));
}

export function isNonSemanticWriting(text) {
  const compact = String(text || '').replace(/\s/g, '');
  return !compact || (!HAN_PATTERN.test(compact) && !containsPinyinLike(compact));
}

export function isUsableEvidence(evidence, fullText, criterionText = '') {
  const value = String(evidence || '').trim();
  if (!value || !String(fullText || '').includes(value)) return false;
  if (/标点|句号|问号|感叹号/.test(criterionText)) {
    return HAN_PATTERN.test(value) || containsPinyinLike(value) || END_MARK_PATTERN.test(value);
  }
  return HAN_PATTERN.test(value) || containsPinyinLike(value);
}

export function isPunctuationCriterion(criterionText) {
  return PUNCTUATION_CRITERION_PATTERN.test(String(criterionText || ''));
}

export function punctuationEvidenceParts(fullText, limit = 3) {
  const text = String(fullText || '');
  const matches = text.match(/[^。！？!?\n]*[。！？!?](?:[”’"》」』】）])?/g) || [];
  const output = [];
  for (const match of matches) {
    const value = match.trim().slice(0, 160);
    if (!value || !END_MARK_PATTERN.test(value) || (!HAN_PATTERN.test(value) && !containsPinyinLike(value))) continue;
    if (!output.includes(value)) output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

export function usableEvidenceParts(result, fullText, criterionText = '', limit = 3) {
  const source = result && typeof result === 'object' ? result : {};
  const candidates = [
    ...(Array.isArray(source.evidenceParts) ? source.evidenceParts : []),
    source.evidence,
  ];
  const output = [];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim().slice(0, 160);
    if (!value || output.includes(value) || !isUsableEvidence(value, fullText, criterionText)) continue;
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

export function feedbackForCriterion(criterionText, index = 0) {
  const text = String(criterionText || '');
  if (isPunctuationCriterion(text)) return '哪句话说完了，需要补上合适的句末标点？';
  if (/完整的句子|完整的一句话|主要意思|主要内容|基本意思|看懂/.test(text)) return '你最想告诉读者的主要事情是什么？';
  if (/主要经过/.test(text)) return '对照每幅图：哪些经过还没有按顺序写出来？';
  if (/连贯|前后/.test(text)) return '读一读前后两句话：它们是否围绕同一件事自然连接？';
  if (/顺序|先后/.test(text)) return '图中的事情先发生了什么，接着又发生了什么？';

  const panel = text.match(/第[一二三四五六七八九十\d]+(?:格|幅|张)/)?.[0];
  if (panel) return `再看${panel}：画面中都有谁，他们正在做什么？`;
  if (/地点|环境|哪里|季节|天气/.test(text)) return '再看画面：事情发生在哪里？';
  if (/人物|谁/.test(text)) return '再看画面：图中都有谁？';
  if (/动作|做什么|事情/.test(text)) return '再看画面：主要人物正在做什么？';
  if (/物品|景物|出现|看到/.test(text)) return '再看画面：你能找到哪些直接看见的景物或物品？';
  if (/细节|具体|样子/.test(text)) return '再看画面：哪个动作或样子还可以观察得更仔细？';
  if (/想象|心情|感受|对话/.test(text)) return '原文中有没有依据画面展开的合理想象？';
  return `请对照第 ${index + 1} 项评价要求，再观察画面中直接出现的内容。`;
}

export function makeInvalidWritingResult(text, criteria) {
  const rawResults = criteria.map((criterion, index) => ({
    criterionId: criterion.id,
    status: criterion.type === 'bonus' ? 'not_shown' : 'unmet',
    evidenceFound: false,
    evidence: '',
    feedback: criterion.type === 'bonus' ? '' : feedbackForCriterion(criterion.text, index),
  }));
  const criterionResults = ensureDistinctFeedback(rawResults, criteria);
  const priorities = uniqueFeedback(criterionResults, criteria, 3);
  const snippet = String(text || '').trim();
  return {
    overall: '需要补充',
    positives: [],
    priorities,
    criteria: criterionResults,
    annotations: snippet ? [{
      id: crypto.randomUUID(),
      start: 0,
      end: snippet.length,
      snippet,
      type: '句子不完整',
      reason: '当前内容还没有形成能够表达画面意思的句子。',
      tone: 'issue',
    }] : [],
  };
}

export function ensureDistinctFeedback(results, criteria) {
  const seen = new Set();
  return results.map((result, index) => {
    if (!['unmet', 'partial'].includes(result.status)) return result;
    let feedback = String(result.feedback || '').trim();
    const key = normalizeFeedback(feedback);
    if (!feedback || seen.has(key)) feedback = feedbackForCriterion(criteria[index]?.text, index);
    let nextKey = normalizeFeedback(feedback);
    if (seen.has(nextKey)) {
      feedback = `请对照第 ${index + 1} 项评价要求，再观察画面中直接出现的内容。`;
      nextKey = normalizeFeedback(feedback);
    }
    seen.add(nextKey);
    return { ...result, feedback };
  });
}

export function uniqueFeedback(results, criteria, limit = 3) {
  return ensureDistinctFeedback(results, criteria)
    .filter((item) => item.status === 'unmet' || item.status === 'partial')
    .sort((a, b) => Number(a.status !== 'unmet') - Number(b.status !== 'unmet'))
    .map((item) => item.feedback)
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .slice(0, limit);
}

function normalizeFeedback(value) {
  return String(value || '').replace(/[\s，。！？：；,.!?:;]/g, '');
}
