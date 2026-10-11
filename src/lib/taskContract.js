export const TASK_TYPE_OPTIONS = [
  ['single_sentence', '单图写一句话'],
  ['single_paragraph', '单图写几句话'],
  ['sequence', '多图连续故事'],
  ['continuation', '已给开头续写'],
  ['guided_imagination', '问题引导想象'],
  ['dialogue', '人物语言或心理'],
  ['observation', '观察指定对象'],
  ['guided_profile', '按提示写人或写事'],
  ['sentence_imitation', '仿照例句写话'],
  ['ending', '补充故事结尾'],
  ['other', '其他写话任务'],
];

const TYPE_LABELS = Object.fromEntries(TASK_TYPE_OPTIONS);

export function emptyTaskContract() {
  return {
    taskType: 'other',
    givenContext: [],
    requiredContent: [],
    providedSupports: [],
    visibleFacts: [],
    imaginationSpace: [],
    uncertainties: [],
  };
}

export function normalizeTaskContract(value, legacySummary = '') {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {
    taskType: TYPE_LABELS[source.taskType] ? source.taskType : 'other',
    givenContext: normalizeList(source.givenContext),
    requiredContent: normalizeList(source.requiredContent),
    providedSupports: normalizeList(source.providedSupports || source.writingSupports),
    visibleFacts: normalizeList(source.visibleFacts),
    imaginationSpace: normalizeList(source.imaginationSpace),
    uncertainties: normalizeList(source.uncertainties),
  };
  if (!value && String(legacySummary || '').trim()) {
    normalized.visibleFacts = [String(legacySummary).trim()];
    normalized.uncertainties = ['这是旧版混合摘要，请重新分析题图或手动确认任务边界。'];
  }
  return normalized;
}

export function taskContractToSummary(value) {
  const contract = normalizeTaskContract(value);
  const sections = [
    ['题目类型', TYPE_LABELS[contract.taskType] || TYPE_LABELS.other],
    ['题目已给背景', contract.givenContext.join('；') || '无'],
    ['孩子需要完成', contract.requiredContent.join('；') || '未明确'],
    ['题目提供的提示或支架', contract.providedSupports.join('；') || '无'],
    ['画面可确认事实', contract.visibleFacts.join('；') || '未确认'],
    ['允许想象范围', contract.imaginationSpace.join('；') || '未明确'],
    ['不确定之处', contract.uncertainties.join('；') || '无'],
  ];
  return sections.map(([label, text]) => `${label}：${text}`).join('\n');
}

export function listToText(value) {
  return normalizeList(value).join('\n');
}

export function textToList(value) {
  return String(value || '')
    .split(/\n+/)
    .map((item) => item.replace(/^[\s•·\-—\d.、]+/, '').trim())
    .filter(Boolean);
}

function normalizeList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (typeof value === 'string') return textToList(value);
  return [];
}
