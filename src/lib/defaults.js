export const GRADE_TWO_BASELINES = {
  starter: [
    '能用一句或几句把主要内容表达清楚',
    '能尝试正确使用句号、问号或感叹号等基本标点',
  ],
  developing: [
    '能用完整的句子把主要意思表达清楚',
    '语句基本通顺，前后意思能够连起来',
    '能尝试正确使用句号、问号或感叹号等基本标点',
  ],
};

export const GRADE_BASELINES = {
  1: [
    '表达的基本意思能够让人看懂',
    '能尝试使用句号、问号或感叹号等基本句末标点',
  ],
  2: GRADE_TWO_BASELINES.starter,
};

const SECOND_GRADE_DEVELOPING_TYPES = new Set([
  'single_paragraph',
  'sequence',
  'continuation',
  'guided_profile',
  'sentence_imitation',
  'ending',
]);

export function inferSecondGradeLevel(grade, taskContract = null) {
  if (Number(grade) !== 2) return 'grade1';
  const contract = taskContract && typeof taskContract === 'object' ? taskContract : {};
  const taskType = String(contract.taskType || 'other');
  const requiredContent = Array.isArray(contract.requiredContent) ? contract.requiredContent : [];
  const providedSupports = Array.isArray(contract.providedSupports) ? contract.providedSupports : [];
  const requiredText = requiredContent.join('；');
  const supportText = providedSupports.join('；');

  if (SECOND_GRADE_DEVELOPING_TYPES.has(taskType)) return 'developing';
  if (requiredContent.length >= 2) return 'developing';
  if (/几句|一段|连成|连起来|前后|按顺序|先后|过程|变化|接着写|续写|仿照|仿写/.test(requiredText)) return 'developing';
  if (/表格|关键词|例句|仿照|仿写/.test(supportText) && taskType !== 'single_sentence') return 'developing';
  return 'starter';
}

export function baselineTexts(grade, taskContract = null) {
  if (Number(grade) === 2) return GRADE_TWO_BASELINES[inferSecondGradeLevel(grade, taskContract)];
  return GRADE_BASELINES[1];
}

export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function makeCriteria(text, type = 'basic', origin = 'teacher') {
  return { id: uid('criterion'), text, type, origin, teacherEdited: false };
}

export function baselineCriteria(grade, taskContract = null) {
  return baselineTexts(grade, taskContract).map((text) => makeCriteria(text, 'basic', 'baseline'));
}

export function createTask() {
  const now = new Date().toISOString();
  return {
    id: uid('task'),
    name: '',
    grade: 1,
    images: [],
    summary: '',
    taskContract: null,
    criteria: baselineCriteria(1),
    standardsConfirmed: false,
    analysisState: 'idle',
    analysisStale: false,
    analysisError: '',
    submissions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function taskState(task) {
  const submissions = task.submissions || [];
  if (!submissions.length) return { label: '待添加', tone: 'neutral' };
  if (submissions.every((item) => item.status === 'completed')) {
    return { label: '已批改', tone: 'success' };
  }
  return { label: '进行中', tone: 'warning' };
}

export function statusLabel(status) {
  return {
    draft: '待确认原文',
    grading: '批改中',
    completed: '已批改',
    failed: '批改失败',
    stale: '需要重新批改',
  }[status] || '待确认原文';
}

export function formatRelativeTime(value) {
  if (!value) return '刚刚';
  const delta = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(delta / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value));
}

export function readFiles(files) {
  return Promise.all(
    Array.from(files).map(async (file) => {
      const originalDataUrl = await fileToDataUrl(file);
      if (!file.type.startsWith('image/')) {
        return { id: uid('image'), name: file.name, dataUrl: originalDataUrl, bytes: file.size, originalBytes: file.size };
      }
      try {
        const image = await loadImage(originalDataUrl);
        const maxEdge = 3200;
        const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
        if (scale === 1 && file.size <= 900 * 1024) {
          return {
            id: uid('image'), name: file.name, dataUrl: originalDataUrl,
            width: image.naturalWidth, height: image.naturalHeight,
            bytes: file.size, originalBytes: file.size, compressed: false,
          };
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
        if (!blob || blob.size >= file.size * 0.95) {
          return {
            id: uid('image'), name: file.name, dataUrl: originalDataUrl,
            width: image.naturalWidth, height: image.naturalHeight,
            bytes: file.size, originalBytes: file.size, compressed: false,
          };
        }
        return {
          id: uid('image'), name: file.name.replace(/\.[^.]+$/, '') + '.jpg',
          dataUrl: await fileToDataUrl(blob), width: canvas.width, height: canvas.height,
          bytes: blob.size, originalBytes: file.size, compressed: true,
        };
      } catch {
        return { id: uid('image'), name: file.name, dataUrl: originalDataUrl, bytes: file.size, originalBytes: file.size, compressed: false };
      }
    }),
  );
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片无法读取'));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
