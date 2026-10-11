import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoAnalyze, demoGrade, demoOcr } from '../src/lib/demoAi.js';
import { baselineTexts, inferSecondGradeLevel } from '../src/lib/defaults.js';
import { normalizeTaskContract, taskContractToSummary } from '../src/lib/taskContract.js';
import {
  containsPinyinLike,
  ensureDistinctFeedback,
  isNonSemanticWriting,
  isPunctuationCriterion,
  isPinyinFormCorrection,
  makeInvalidWritingResult,
  punctuationEvidenceParts,
  usableEvidenceParts,
  uniqueFeedback,
} from '../src/lib/gradingGuards.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadLocalEnv(path.join(root, '.env'));

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || '127.0.0.1';
const publicAppId = 'picture-writing-workbench-v1';
const appUsername = process.env.APP_USERNAME || 'teacher';
const appPassword = process.env.APP_PASSWORD || '';
const requireAppPassword = process.env.REQUIRE_APP_PASSWORD === '1';
const requireModelKeys = process.env.REQUIRE_MODEL_KEYS === '1';
const allowedOrigins = new Set(String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map((item) => item.trim()).filter(Boolean));
const rateLimitWindowMs = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000));
const rateLimitMax = Math.max(0, Number(process.env.RATE_LIMIT_MAX || 30));
const rateLimitBuckets = new Map();
const ocrMaxTokens = Math.max(1024, Number(process.env.OCR_MAX_OUTPUT_TOKENS || 4096));
const gradeMaxTokens = Math.max(2048, Number(process.env.GRADE_MAX_OUTPUT_TOKENS || 4096));
const criteriaMaxTokens = Math.max(1024, Number(process.env.CRITERIA_MAX_OUTPUT_TOKENS || 2048));
const kimi = {
  label: 'Kimi',
  apiKey: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || '',
  baseUrl: (process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/$/, ''),
  model: process.env.KIMI_VISION_MODEL || 'kimi-k2.6',
};
const deepseek = {
  label: 'DeepSeek',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
  model: process.env.DEEPSEEK_TEXT_MODEL || 'deepseek-flash',
};

if (requireAppPassword && !appPassword) throw new Error('云端模式要求配置 APP_PASSWORD');
if (requireAppPassword && allowedOrigins.size === 0) throw new Error('云端模式要求配置 CORS_ALLOWED_ORIGINS');
if (requireModelKeys && (!kimi.apiKey || !deepseek.apiKey)) throw new Error('云端模式要求同时配置 Kimi 和 DeepSeek 密钥');

const server = http.createServer(async (request, response) => {
  if (!isOriginAllowed(request)) return json(response, 403, { error: '当前来源不允许访问此服务' }, request);
  if (request.method === 'OPTIONS') return send(response, 204, '', request);
  if (request.method === 'GET' && request.url === '/api/health') return json(response, 200, healthStatus(), request);
  if (request.method !== 'POST') return json(response, 404, { error: 'Not found' }, request);
  if (!isExpectedApp(request)) return json(response, 403, { error: '应用身份不匹配' }, request);
  const retryAfter = applyRateLimit(request);
  if (retryAfter > 0) return json(response, 429, { error: '请求过于频繁，请稍后再试' }, request, { 'Retry-After': String(retryAfter) });
  if (!isAuthorized(request)) return json(response, 401, { error: '访问密码不正确或已经失效' }, request, {
    'WWW-Authenticate': 'Basic realm="Picture Writing Workbench"',
  });
  if (request.url === '/api/auth') return json(response, 200, { ok: true }, request);
  try {
    const body = await readJson(request);
    if (request.url === '/api/analyze-picture') return json(response, 200, await analyzePicture(body), request);
    if (request.url === '/api/ocr') return json(response, 200, await ocr(body), request);
    if (request.url === '/api/grade') return json(response, 200, await grade(body), request);
    return json(response, 404, { error: 'Not found' }, request);
  } catch (error) {
    console.error(error);
    return json(response, error.status || 500, { error: error.message || '服务暂时不可用' }, request);
  }
});

server.listen(port, host, () => {
  const health = healthStatus();
  console.log(`Picture-writing AI service listening on http://${host}:${port} (${health.mode} mode)`);
  console.log(`Vision/OCR: ${health.providers.vision}; criteria/grading: ${health.providers.text}`);
});

async function analyzePicture(body) {
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (!images.length) throw badRequest('缺少题图');
  const grade = Number(body.grade) === 2 ? 2 : 1;
  const teacherSummary = String(body.summary || '').trim();
  const teacherContract = body.taskContract && typeof body.taskContract === 'object'
    ? normalizeTaskContract(body.taskContract)
    : null;
  const fallback = await demoAnalyze({ grade, imageCount: images.length, skipDelay: true });
  const taskContract = ensureMinimumTaskContract(teacherContract
    || (teacherSummary && deepseek.apiKey ? await structureTaskContract({ summary: teacherSummary, grade }) : null)
    || (kimi.apiKey ? await recognizeTaskPicture({ images, grade }) : fallback.taskContract), images.length, grade);
  const summary = taskContractToSummary(taskContract);
  const rawCriteria = deepseek.apiKey
    ? await createCriteria({ taskContract, grade })
    : fallback.criteria;
  return {
    demo: !kimi.apiKey || !deepseek.apiKey,
    providers: { vision: kimi.apiKey ? 'kimi' : 'demo', text: deepseek.apiKey ? 'deepseek' : 'demo' },
    summary,
    taskContract,
    criteria: rawCriteria.slice(0, 5).map((item) => ({
      id: crypto.randomUUID(),
      text: String(item.text || '').trim(),
      type: item.type === 'bonus' ? 'bonus' : 'basic',
      origin: 'ai',
      teacherEdited: false,
    })).filter((item) => item.text),
  };
}

async function ocr(body) {
  const images = Array.isArray(body.images) ? body.images.slice(0, 12) : [];
  const grade = Number(body.grade) === 2 ? 2 : 1;
  if (!images.length) throw badRequest('缺少学生作品图片');
  if (!kimi.apiKey) return demoOcr();
  const prompt = `你只负责忠实转写${grade === 2 ? '二年级' : '一年级'}学生的手写作文，不负责修改。请按图片编号顺序读取并输出 JSON Object：{"text":"完整原文","needsReview":false,"reviewNote":"","formatReview":{"available":false,"needsTeacherReview":false,"notes":[]}}。
规则：
1. 保留学生原有的错别字、语病、重复、稚拙表达、分段和标点，绝对不要润色或纠错。
2. 学生用拼音代替不会写的汉字时，必须按原样保留拼音，不要转换成汉字；声调、空格或拼写不规范也不要擅自纠正。
3. 看不清的单个字用“□”表示，连续看不清就逐字使用“□”，不得根据语义猜写。
4. 如果图片之间内容有重叠，只保留一次；如果有标题则保留标题。
5. 如果有多个字无法确认、连续语句无法可靠辨认或图片质量影响转写，needsReview=true，并在 reviewNote 中简短说明需要老师重点核对的位置；不要为了让句子通顺而猜字。
6. 只输出学生实际书写内容，不输出分析、Markdown 或图片编号。
7. formatReview 只记录图片能够直接确认的书写格式，供老师参考，不参与文字内容评分：只有方格和书写位置都清楚可见时 available=true；可观察“字是否基本落在格内、标点是否单独占格、书写是否影响辨认”。普通横线纸、白纸或拍摄角度不清时 available=false，不能说孩子格式错误。notes 最多 3 条，只写直接观察，不评价字漂不漂亮；只有确实需要老师核对时 needsTeacherReview=true。`;
  const content = [{ type: 'text', text: prompt }];
  images.forEach((url, index) => {
    content.push({ type: 'text', text: `第 ${index + 1} 张图片：` });
    content.push({ type: 'image_url', image_url: { url } });
  });
  const data = await chat(kimi, [{ role: 'user', content }], { thinking: { type: 'disabled' }, max_tokens: ocrMaxTokens });
  const parsed = parseJson(data);
  return {
    text: String(parsed.text || ''),
    provider: 'kimi',
    needsReview: parsed.needsReview === true || String(parsed.text || '').includes('□'),
    reviewNote: String(parsed.reviewNote || '').trim().slice(0, 180),
    formatReview: normalizeFormatReview(parsed.formatReview),
  };
}

async function grade(body) {
  const text = String(body.text || '').trim();
  const criteria = Array.isArray(body.criteria) ? body.criteria : [];
  const grade = Number(body.grade) === 2 ? 2 : 1;
  const textConfirmed = body.textConfirmed === true;
  const taskContract = normalizeTaskContract(body.taskContract, body.summary);
  const secondGradeLevel = inferSecondGradeLevel(grade, taskContract);
  if (!text) throw badRequest('学生原文为空');
  if (!criteria.length) throw badRequest('评价点为空');
  if (isNonSemanticWriting(text)) {
    return { ...makeInvalidWritingResult(text, criteria), provider: 'local-validation' };
  }
  if (!deepseek.apiKey) return demoGrade({ text, criteria });
  const prompt = `你是一名严谨、温和的小学低年级语文老师。依据老师确认的“任务合同”和评价点批改学生原文。

任务合同：${JSON.stringify(taskContract)}
年级：${grade === 2 ? '二年级' : '一年级'}
原文状态：${textConfirmed ? '老师已在批改前对照作品确认这份转写，其中的拼音是学生原文，不是 OCR 异常' : '未标记为老师已确认'}
评价点：${JSON.stringify(criteria.map(({ id, text: criterionText, type }) => ({ id, text: criterionText, type })))}
学生原文（必须忠实引用）：${JSON.stringify(text)}

规则：
1. 只评价 requiredContent 和老师确认的评价点。givenContext 是题目已经提供的背景，不能要求孩子重复；providedSupports 是提示问题、关键词、表格或例句，只帮助孩子展开，不能要求逐字照抄、使用全部关键词或采用固定顺序；visibleFacts 用于判断是否明显偏离画面，不等于每项都必须写。
2. basic 状态只能是 achieved、partial、unmet、review。achieved 表示核心要求已经清楚表达；partial 表示核心意思已出现但关键关系或表达仍不完整；unmet 表示没有相关内容；review 只用于原文存在多处无法理解、疑似识别错误，导致这一项无法可靠判断。bonus 只能是 highlight、not_shown，且不影响整体结论。
3. 对每个评价点单独找证据。evidenceFound=true 时必须输出 evidenceParts，包含 1—3 段学生原文中的连续原句或最小必要短语，每一段都必须逐字来自原文、不能改写。一个连续片段足以证明时只放一段；人物、办法、对象或结果分散在前后句时，必须用多段原文共同证明，不能因为证据不连续就判未达成。evidenceParts 合在一起必须覆盖评价点里的关键关系：评价点出现明确人物、接收对象或结果，并且该名称或结果确实出现在原文中时，必须引用包含它的原文片段。例如判断“想办法把信寄给旺达”，应同时引用“请邮递员传信”和“旺达看见信”等相关片段，不能只引用前半个办法。证据必须真实支持核心人物关系、动作或事件，不能只凭同名词语凑证据。没有直接相关证据时必须 evidenceFound=false、evidenceParts=[]、evidence=""。
4. 内容评价与语言问题必须分成两条线。孩子已经表达出核心事件，即使句中有错字、拼音、少量标点、儿童口语或不规范词序，内容项仍可达成；错字只能进入用字订正，不能让人物、地点、动作或事件变成未达成。只有存在多种合理解释且不同解释会实质改变这一项的判断时，才可使用 review。
5. 低年级允许用拼音代替不会写的汉字。带声调、不带声调、声调不准、音节连写、与汉字相连、大小写混用或轻微拼写不规范，都不能判为错别字，不能要求改成汉字，也不能列入 priorities 或负向 annotations。应结合上下文保守理解；实在无法确认时使用 review，不得猜写。
6. 孩子使用“小猴”“小朋友”“他们”“她们”等一般称呼，只要上下文能对应人物，就视为匹配；明确代词不能仅因没有重复人物全名而判错。颜色、大小、衣着等外观细节不能成为否定核心事件的唯一理由。
7. 对低年级常见的谐音错字、近音错字和稚拙写法，先结合任务合同、题图事实、前后文和读音理解孩子想表达的意思。如果能够形成唯一且合理的理解（例如在明确的寄信情境中把“由地园”理解为“邮递员”），内容评价必须按这个合理含义判断，evidence 仍原样引用“由地园”；同时在原词上输出“错别字”标注，并在 correction 中只给正确词语“邮递员”。绝不能暗中改写学生原文。标错前必须把所在的完整句子重新读通：原词本身能够组成正确词语或固定搭配时不得纠正，例如“正当……的时候”中的“正当”是正确表达，绝不能把“正”改成“成”。
8. 错别字订正只能给词语，不能提供替换整句。一个或少量能够理解的错别字不应改变已经达成的基本评价点，也不能单独降低整体结论；它只作为独立的用字订正显示。只有语言问题已经影响意思理解时，才依据对应的“表达是否清楚”基本评价点判断为 partial 或 unmet。同一个错词重复出现时可以标出各处，但第一次给完整订正，后续只作同类轻提示，不重复批评或累计降低评价。对于“尝试使用句号、问号或感叹号”等基础标点评价，只要原文中至少有一句清楚使用了这些句末标点，就应判为 achieved；其他局部标点问题可另行标注，不能把整项判为 unmet。
9. 只有原字清楚、存在两个以上合理解释，而且不同解释会实质改变评价结果时，才使用“表达待核对”；这类疑点最多 2 处，不触发整篇 reviewRequired，也不能先把相关内容判为 partial 或 unmet。不影响评价结论的轻微歧义应按最合理含义继续批改，不询问老师。“识别待核对”只用于未确认原文时无法确认孩子究竟写了什么，不能与错别字混用。
10. 人物姓名、地名、作品专名和孩子自创称呼不能仅凭常识判错；只有任务文字、题图文字或上下文明确给出标准写法时才可订正。字都正确但带有儿童口语、稚拙句式或不规范词序时，应按可理解的原意评价内容，只标注表达问题，不判成错别字，也不改写成成人化句子。
11. ${grade === 2
    ? (secondGradeLevel === 'developing'
      ? '当前是二年级进阶写话：更关注完整句、意思清楚和前后能够连起来，但仍不设置硬性字数、句数或段落。只有多图、过程性画面或题目明确要求顺序时，才评价主要过程是否按图意讲清；不强制使用特定顺序词。仿写只判断表达关系是否仿照成功，不要求复制例句内容或某个连接词。人物、地点、事情是整体理解骨架，不能拆成机械扣分表。'
      : '当前是二年级起步写话：仍以愿意写、把主要内容表达清楚为主。允许写一句或几句；不能仅因没有成段、句子较少、没有衔接词或未写齐四要素就判低。只有题目明确要求多项内容、顺序或仿写关系时，才评价对应内容。')
    : '一年级以表达意愿和基本清楚为主。时间、人物、地点、事件四要素只作为观察支架；题目没有明确要求、或缺少后仍能看懂时，不得逐项扣分。题目要求一句话时不强求多句。'}题目要求续写时不要求复述开头；合理想象没有唯一答案。
12. partial/unmet 只给一条针对当前核心缺口的引导问题；不能直接给答案。引导问题只能围绕任务合同、当前评价点或原文明确出现的内容，不能增加新情节。achieved、review 和 bonus 不给修改句；bonus 为 not_shown 时 feedback 必须为空。
13. 原句存在明确的错别字、标点、语病、重复或句子不完整时，只标注问题和简短原因，不提供完整替换句。错别字的 snippet 必须圈出完整错词或最小词组，correction 只放对应的正确词语或最小词组；禁止脱离词语单独输出一个汉字到另一个汉字的猜测性订正。其他标注的 correction 必须为空。标注必须落在真正有问题的原文片段上，start/end 必须精确对应该片段。
14. positives 必须绑定一个 achieved 或 highlight 的 criterionId，并引用该项已经找到的证据；不能表扬被同一评价点判为 partial、unmet 或 review 的内容。最多 3 条。priorities 只能来自 unmet 或 partial 的 feedback，最多 3 条，未达成优先。
15. ${textConfirmed
    ? '老师已确认原文，不得再以“疑似 OCR 误识别”为由设置 review。拼音数量多、声调不准、拼写不规范或拼音与汉字混写，都不能触发 reviewRequired。只有原文明确保留了多个“□”等未识别占位符，导致核心内容无法判断时，才可设置 review。意思可以确认的稚拙、语病或重复表达应继续正常评价。'
    : '如果原文有两处及以上无法解释的词组、疑似 OCR 误识别、连续“□”，或必须靠猜字才能读懂，必须设置 reviewRequired=true 并说明 reviewReason；相关 basic 使用 review。'}
16. annotations 的 type 负向仅可用：错别字、标点、语病、重复、句子不完整、图文不符；中性核对仅可用：识别待核对、表达待核对；正向仅用亮点。纯数字、纯符号或随机字符不能作证据，但纯拼音或汉字拼音混写可以是有效表达。仅凭转写文字无法判断“是否写在格子中间、标点是否单独占格、书写是否端正整洁”，不得推断这些书写格式问题。
17. interpretations 用来记录内容判断中实际采用的非字面理解。只要某项之所以判为 achieved/partial，是因为把原文中的近音错词理解成了另一个明确词语，就必须记录 source、intended、kind="typo"、confidence="high"；不能只在心里纠正却省略记录。普通同义表达、拼音代写、姓名和不确定猜测不要放入 interpretations。
输出严格 JSON Object：{"reviewRequired":false,"reviewReason":"","positives":[{"criterionId":"...","text":"...","evidence":"..."}],"criteria":[{"criterionId":"...","status":"...","evidenceFound":true,"evidenceParts":["前一句中的直接证据","后一句中的直接证据"],"evidence":"第一段证据","feedback":""}],"interpretations":[{"source":"由地园","intended":"邮递员","kind":"typo","confidence":"high"}],"annotations":[{"start":0,"end":3,"snippet":"由地园","type":"错别字","correction":"邮递员","reason":"这里想写的是‘邮递员’。","tone":"issue"}]}`;
  let data = await chat(deepseek, [{ role: 'user', content: prompt }], {
    thinking: { type: 'disabled' },
    max_tokens: gradeMaxTokens,
  });
  let parsed = parseJson(data);
  if (textConfirmed && containsPinyinLike(text) && !text.includes('□') && hasReviewOutcome(parsed)) {
    data = await chat(deepseek, [{ role: 'user', content: `${prompt}\n\n重新判断：这份原文已经老师确认，拼音是学生不会写汉字时的正常代写。不得因为拼音多、声调或拼写不规范而输出 review/reviewRequired；请结合上下文完成正常的内容评价。` }], {
      thinking: { type: 'disabled' },
      max_tokens: gradeMaxTokens,
    });
    parsed = parseJson(data);
  }
  if (hasInvalidPositiveEvidence(parsed, criteria, text)) {
    data = await chat(deepseek, [{ role: 'user', content: `${prompt}\n\n重新检查证据：上一版把某些 achieved/partial 的证据改写了、拼接成了原文中不存在的长句，或遗漏了跨句证据。请保持真实评价状态，并用 evidenceParts 分别逐字引用原文中的 1—3 个连续片段；不要为了满足格式而降低原本已有充分依据的评价。` }], {
      thinking: { type: 'disabled' },
      max_tokens: gradeMaxTokens,
    });
    parsed = parseJson(data);
  }
  const inferredAnnotations = annotationsFromInterpretations(parsed.interpretations, text);
  const normalizedAnnotations = normalizeAnnotations([...(Array.isArray(parsed.annotations) ? parsed.annotations : []), ...inferredAnnotations], text);
  const hasExpressionReview = normalizedAnnotations.some((item) => item.type === '表达待核对');
  const localReviewRequired = needsOcrReview(text, normalizedAnnotations, textConfirmed);
  const criterionResults = criteria.map((criterion) => {
    const localPunctuationEvidence = criterion.type === 'basic' && isPunctuationCriterion(criterion.text)
      ? punctuationEvidenceParts(text, 3)
      : [];
    if (localPunctuationEvidence.length) {
      return {
        criterionId: criterion.id,
        status: 'achieved',
        evidenceFound: true,
        evidence: localPunctuationEvidence.join('……'),
        evidenceParts: localPunctuationEvidence,
        feedback: '',
      };
    }
    const found = (parsed.criteria || []).find((item) => item.criterionId === criterion.id) || {};
    const evidenceParts = usableEvidenceParts(found, text, criterion.text, 3);
    const evidenceFound = found.evidenceFound === true && evidenceParts.length > 0;
    const rawStatus = criterion.type === 'bonus'
      ? (found.status === 'highlight' && evidenceFound ? 'highlight' : 'not_shown')
      : (['achieved', 'partial', 'unmet', 'review'].includes(found.status) ? found.status : 'review');
    let status = rawStatus;
    const invalidEvidenceDowngrade = criterion.type === 'basic' && !evidenceFound && ['achieved', 'partial'].includes(rawStatus);
    if (criterion.type === 'bonus' && status === 'not_shown') {
      return { criterionId: criterion.id, status, evidenceFound: false, evidence: '', feedback: '' };
    }
    if (criterion.type === 'basic' && !evidenceFound && ['achieved', 'partial'].includes(status)) status = 'unmet';
    if (status === 'review' && textConfirmed && !localReviewRequired && !hasExpressionReview) {
      status = evidenceFound ? 'partial' : 'unmet';
    }
    if (status === 'review') {
      return { criterionId: criterion.id, status, evidenceFound: false, evidence: '', feedback: '' };
    }
    return {
      criterionId: criterion.id,
      status,
      evidenceFound,
      evidence: evidenceFound ? evidenceParts.join('……') : '',
      evidenceParts: evidenceFound ? evidenceParts : [],
      feedback: criterion.type === 'bonus' || status === 'achieved' || invalidEvidenceDowngrade ? '' : String(found.feedback || '').trim().slice(0, 180),
    };
  });
  const normalizedResults = ensureDistinctFeedback(criterionResults, criteria);
  const basicResults = normalizedResults.filter((item) => criteria.find((criterion) => criterion.id === item.criterionId)?.type === 'basic');
  const modelReviewRequired = !textConfirmed && (parsed.reviewRequired === true || basicResults.some((item) => item.status === 'review'));
  const reviewRequired = localReviewRequired || modelReviewRequired;
  const supportedAnnotations = filterSupportedAnnotations(normalizedAnnotations, normalizedResults);
  const hasTeacherReviewItem = supportedAnnotations.some((item) => item.tone === 'neutral');
  const overall = reviewRequired
    ? '建议核对原文'
    : basicResults.some((item) => item.status === 'unmet')
      ? '需要补充'
    : basicResults.some((item) => item.status === 'partial' || item.status === 'review') || hasTeacherReviewItem
      ? '基本完成'
      : '完成得很好';
  const priorities = reviewRequired ? [] : uniqueFeedback(normalizedResults, criteria, 3);
  const positives = reviewRequired ? [] : normalizeSupportedPositives(parsed.positives, normalizedResults, criteria, text, 3);
  return {
    overall,
    reviewRequired,
    reviewReason: reviewRequired
      ? String(parsed.reviewReason || (localReviewRequired
        ? '检测到多处意思不清或疑似识别错误的文字，请老师对照作品图片核对后再批改。'
        : '原文中有部分内容无法可靠辨认，请老师对照作品图片核对后再判断。')).trim().slice(0, 180)
      : '',
    provider: 'deepseek',
    positives,
    priorities,
    criteria: normalizedResults,
    teacherReviewItems: reviewRequired ? [] : normalizeTeacherReviewItems(supportedAnnotations),
    annotations: reviewRequired ? [] : supportedAnnotations,
  };
}

async function recognizeTaskPicture({ images, grade }) {
  const prompt = `你是小学低年级看图写话的题目识别助手。你只负责识图、忠实读出印刷文字，并把题目拆成“任务合同”，不生成评价点。图片按编号顺序组成同一道题。
年级：${grade === 2 ? '二年级' : '一年级'}。
规则：
1. taskType 只能是 single_sentence、single_paragraph、sequence、continuation、guided_imagination、dialogue、observation、guided_profile、sentence_imitation、ending、other。
2. givenContext 只放题目已经给出的开头、人物、地点、起因和已经发生的情节；这些不是孩子必须重复写的内容。
3. requiredContent 只放印刷题目明确要求孩子本次说或写的内容。特别注意“接着写”“想一想”“会说什么、做什么”等任务动词；不要把观察画面的四要素机械地全部设为要求。
4. providedSupports 只放印刷题目提供的提示问题、关键词、表格栏目、句式或例句。这些用于帮助孩子展开，不等于标准答案；除非题目明确要求“仿照”或“用上”，否则不要放进 requiredContent。
5. visibleFacts 只放画面能够直接确认的人物、动作、场景、物品和多图顺序；不要补充看不到的心理、原因、对话或结果。
6. imaginationSpace 说明题目允许孩子自由想象的范围。开放问题没有唯一答案，不要预设具体情节。
7. uncertainties 逐条记录看不清的文字、人物身份、多图顺序或文字与画面冲突；不确定时不得猜测。
8. ${grade === 2
    ? '二年级也必须先忠实识别题目边界：单图一句、简单观察或开放表达应保持起步要求；多图顺序、续写、仿写、表格提示或多项明确任务才支持进阶要求。仿写、表格或关键词是表达支架，不要把示例内容当成孩子必须写的内容。'
    : '一年级起步阶段以愿意表达、基本看懂为主；不能擅自增加字数、分段、修辞、完整六要素或其他拔高要求。'}
9. 写在方格中、标点占格和书写整洁属于作品图片的书写观察，不能从题图识别成 requiredContent，也不能自动生成文字内容评价点。
输出严格 JSON Object：{"taskType":"...","givenContext":["..."],"requiredContent":["..."],"providedSupports":["..."],"visibleFacts":["..."],"imaginationSpace":["..."],"uncertainties":["..."]}。没有内容的数组输出 []。`;
  const content = [{ type: 'text', text: prompt }];
  images.forEach((url, index) => {
    content.push({ type: 'text', text: `第 ${index + 1} 幅题图：` });
    content.push({ type: 'image_url', image_url: { url } });
  });
  const data = await chat(kimi, [{ role: 'user', content }], { thinking: { type: 'disabled' }, max_tokens: criteriaMaxTokens });
  const parsed = parseJson(data);
  const contract = normalizeTaskContract(parsed);
  if (!contract.requiredContent.length && !contract.visibleFacts.length && !contract.givenContext.length) {
    throw providerError('Kimi 没有返回可用的任务边界');
  }
  return contract;
}

async function structureTaskContract({ summary, grade }) {
  const prompt = `你是小学低年级看图写话教研员。请把老师提供的旧版混合摘要拆成任务合同，不补充摘要中没有的信息。
年级：${grade === 2 ? '二年级' : '一年级'}
旧版摘要：${JSON.stringify(summary)}
严格区分：题目已经给出的背景 givenContext、孩子本次必须完成的 requiredContent、题目提供的提示/关键词/表格/例句 providedSupports、画面直接可见的 visibleFacts、允许自由想象的 imaginationSpace、无法确定的 uncertainties。
taskType 只能是 single_sentence、single_paragraph、sequence、continuation、guided_imagination、dialogue、observation、guided_profile、sentence_imitation、ending、other。
题目已经提供的开头和事实不能进入 requiredContent；没有把握的内容进入 uncertainties。
提示、关键词、表格和例句默认只是 providedSupports；只有摘要明确说必须仿照或必须写某几项时，才把对应任务放入 requiredContent。
输出严格 JSON Object：{"taskType":"...","givenContext":["..."],"requiredContent":["..."],"providedSupports":["..."],"visibleFacts":["..."],"imaginationSpace":["..."],"uncertainties":["..."]}。`;
  const data = await chat(deepseek, [{ role: 'user', content: prompt }], { thinking: { type: 'disabled' }, max_tokens: criteriaMaxTokens });
  return normalizeTaskContract(parseJson(data));
}

async function createCriteria({ taskContract, grade }) {
  const secondGradeLevel = inferSecondGradeLevel(grade, taskContract);
  const baselines = baselineTexts(grade, taskContract);
  const prompt = `你是熟悉中国小学一、二年级看图写话的教研员。请根据老师可编辑的任务合同生成本题专属评价点。

年级：${grade === 2 ? '二年级' : '一年级'}
要求强度：${grade === 2 ? (secondGradeLevel === 'developing' ? '进阶写话' : '起步写话') : '一年级起步表达'}
任务合同：${JSON.stringify(normalizeTaskContract(taskContract))}
系统已经固定包含的年级基础要求：${JSON.stringify(baselines)}

要求：
1. 本题专属 basic 只来自 requiredContent。givenContext 是题目已给背景，不能要求孩子重复；providedSupports 只是提示、关键词、表格或例句，不能要求逐字照抄、全部使用或固定顺序；visibleFacts 只用于理解和防止明显图文不符，不能机械地全部变成评价点。
2. 每项 requiredContent 最多对应 1 条 basic，并且按 requiredContent 的顺序输出。简单单图一句话且 requiredContent 只有 1 项时，只生成 1 条本题 basic；多图、续写或复合要求可生成 2–3 条。不要重复系统已有的基本清楚和句末标点要求。
3. requiredContent 中的明确想象任务仍然是 basic，例如题目明确要求“想办法”“写反应”；只能把更具体、更生动的语言、动作、心理或自然结尾设为 bonus。评价点不要在括号中列出候选办法、对话、心理或答案，只描述需要判断的核心内容。
4. 人物、时间、地点、事件是观察支架，不是固定扣分表。二年级普通单图任务可以合并成一条“把主要人物、地点和事情写清楚”，但不得拆成多个机械扣分项；题目未要求、已在 givenContext 提供、画面无法确认或缺少后仍能理解时，不得单独设为 basic。
5. 评价点聚焦核心人物关系、动作和事件。颜色、大小、衣着可以帮助识别人，但不能成为达成门槛；一般称呼或明确代词应当接受。
6. “看到的”只有在题目要求描述画面时才作为 basic；“想到的”应当适量，合理想象没有唯一答案，不能预设唯一办法、对话、心理或结局。
7. ${grade === 2
    ? (secondGradeLevel === 'developing'
      ? '当前是进阶写话：系统基础要求已经评价完整句、基本通顺连贯和基本标点，本题评价点不要重复。只有 sequence、多图或明确过程任务才设置“按图意讲清主要过程”；不强制特定顺序词。仿写只判断是否表达出相近关系，不要求复制例句词语或某一连接词。'
      : '当前是起步写话：系统基础要求只评价一句或几句是否把主要内容表达清楚，以及是否尝试使用基本标点。本题不要另外增加成段、多句、衔接词、完整四要素或详细结构要求。')
    : '一年级不设置字数、强制分段、完整六要素、修辞或高级结构要求；拼音替代汉字不影响内容评价。'}
8. 两个年级都不设置硬性字数或句数，不要求固定段落、完整六要素或唯一写作顺序；拼音替代汉字不影响内容评价。方格位置、标点占格、字迹端正整洁不能从转写文本可靠判断，不生成自动评价点。
9. 生成 0–2 条 bonus，只记录正向亮点，不要求孩子补写。bonus 只能评价是否写得具体、生动或衔接自然，不得预设某一种办法、某一句对话、某一种心情词或某一个结局，也不得在评价点中列出“开心、高兴、快乐”等候选答案。每条只写一句能够从学生原文判断的自然语言要求。
输出严格 JSON Object：{"criteria":[{"text":"……","type":"basic"},{"text":"……","type":"bonus"}]}。`;
  const data = await chat(deepseek, [{ role: 'user', content: prompt }], {
    thinking: { type: 'disabled' },
    max_tokens: criteriaMaxTokens,
  });
  const parsed = parseJson(data);
  const generated = (Array.isArray(parsed.criteria) ? parsed.criteria : [])
    .map((item) => {
      const type = item.type === 'bonus' ? 'bonus' : 'basic';
      return { text: normalizeGeneratedCriterion(item.text, type, taskContract), type };
    })
    .filter((item) => item.text);
  const contract = normalizeTaskContract(taskContract);
  const basicLimit = Math.max(1, Math.min(3, contract.requiredContent.length));
  const generatedBasics = ['single_sentence', 'observation'].includes(contract.taskType) && contract.requiredContent.length === 1
    ? [{ text: criterionFromRequirement(contract.requiredContent[0]), type: 'basic' }]
    : generated.filter((item) => item.type === 'basic').slice(0, basicLimit);
  const criteria = [
    ...generatedBasics,
    ...generated.filter((item) => item.type === 'bonus').slice(0, 2),
  ];
  if (!criteria.length) throw providerError('DeepSeek 没有返回可用的评价点');
  return criteria;
}

function ensureMinimumTaskContract(value, imageCount = 1, grade = 1) {
  const contract = normalizeTaskContract(value);
  if (contract.requiredContent.length) return contract;
  const sequence = contract.taskType === 'sequence' || imageCount > 1;
  return {
    ...contract,
    taskType: contract.taskType === 'other' ? (sequence ? 'sequence' : 'single_sentence') : contract.taskType,
    requiredContent: [sequence
      ? (grade === 2 ? '按画面顺序写清多幅图中主要事情的变化过程' : '写出多幅图中主要事情的先后变化')
      : (grade === 2 ? '用一句或几句把画面中的主要人物和事情写清楚' : '用一句或几句话写出画面中最主要的人物和事情')],
    uncertainties: [...contract.uncertainties, `题图中未识别到明确写话要求，当前采用${grade === 2 ? '二' : '一'}年级最低通用任务，请老师确认。`],
  };
}

function normalizeGeneratedCriterion(text, type, taskContract) {
  const value = String(text || '').trim();
  const contract = normalizeTaskContract(taskContract);
  if (type === 'bonus' && /[“「『"].{0,24}[”」』"].*(?:等)?(?:词语|说法|表达)/.test(value)) {
    if (/心情|心理|感受|开心|高兴|快乐|难过/.test(value)) return '如果原文有自然的心情或感受描写，能让画面更生动';
    return '如果原文有具体、自然的表达，能让画面更生动';
  }
  const exactConnectorRequired = contract.requiredContent.some((item) => /(?:必须|请|要)?用(?:上)?[“"「『]?(?:就像|好像|仿佛|像)[”"」』]?/.test(item));
  if (type === 'basic'
    && contract.taskType === 'sentence_imitation'
    && !exactConnectorRequired
    && /(?:用|使用).{0,8}(?:就像|好像|仿佛).{0,12}(?:表达|句式|句子)/.test(value)) {
    return '能仿照例句表达景物的特点和合理联想';
  }
  return value;
}

function criterionFromRequirement(value) {
  const text = String(value || '').trim().replace(/^(?:请你|请|要求孩子)\s*/, '');
  if (!text) return '';
  if (/^能/.test(text)) return text;
  if (/^(?:用|写|说|介绍|表达|观察|想)/.test(text)) return `能${text}`;
  return `能完成：${text}`;
}

async function chat(provider, messages, extraBody = {}) {
  const url = `${provider.baseUrl}/chat/completions`;
  const requestBody = {
    model: provider.model,
    messages,
    response_format: { type: 'json_object' },
    ...extraBody,
  };
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await sendChatRequest(provider, url, requestBody);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt === 1) throw error;
      console.warn(`${provider.label}: ${error.retryReason || '响应不完整'}，正在自动重试。`);
      await wait(700 * (attempt + 1));
    }
  }
  throw lastError;
}

async function sendChatRequest(provider, url, requestBody) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    if (isLocalCertificateError(error)) {
      console.warn(`${provider.label}: Node 证书链不可用，改用系统 curl 发起已验证的 HTTPS 请求。`);
      return readChatContent(await chatWithSystemCurl(provider, url, requestBody), provider);
    }
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text();
    throw providerError(`${provider.label} 请求失败（${response.status}）：${detail.slice(0, 180)}`);
  }
  return readChatContent(await response.json(), provider);
}

function readChatContent(payload, provider) {
  const choice = payload.choices?.[0] || {};
  const content = choice.message?.content;
  if (!String(content || '').trim()) {
    const reason = String(choice.finish_reason || 'unknown');
    const error = providerError(`${provider.label} 返回了空内容（结束原因：${reason}），自动重试后仍未成功`);
    error.retryable = true;
    error.retryReason = `返回空内容（结束原因：${reason}）`;
    throw error;
  }
  return content;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalCertificateError(error) {
  return new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]).has(error?.cause?.code);
}

function chatWithSystemCurl(provider, url, requestBody) {
  return new Promise((resolve, reject) => {
    const command = 'exec /usr/bin/curl -sS --fail-with-body --max-time 120 "$PICTURE_AI_URL" -H "Content-Type: application/json" -H "Authorization: Bearer $PICTURE_AI_API_KEY" --data-binary @-';
    const child = spawn('/bin/zsh', ['-c', command], {
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        PICTURE_AI_URL: url,
        PICTURE_AI_API_KEY: provider.apiKey,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { errorOutput += chunk; });
    child.on('error', () => reject(providerError(`${provider.label} 请求无法启动`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(providerError(`${provider.label} 请求失败：${(output || errorOutput).slice(0, 180)}`));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(providerError(`${provider.label} 返回内容无法解析`));
      }
    });
    child.stdin.end(JSON.stringify(requestBody));
  });
}

function annotationsFromInterpretations(input, text) {
  const output = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.kind !== 'typo' || item?.confidence !== 'high') continue;
    const source = String(item.source || '').trim();
    const intended = normalizeWordCorrection(item.intended);
    if (source.length < 2 || intended.length < 2 || source === intended || !text.includes(source) || containsPinyinLike(source)) continue;
    allIndexesOf(text, source).forEach((start) => {
      output.push({
        start,
        end: start + source.length,
        snippet: source,
        type: '错别字',
        correction: intended,
        reason: `这里想写的是“${intended}”。`,
        tone: 'issue',
      });
    });
  }
  return output;
}

function normalizeAnnotations(input, text) {
  const allowed = new Set(['错别字', '标点', '语病', '重复', '句子不完整', '图文不符', '识别待核对', '表达待核对', '亮点']);
  const annotations = (Array.isArray(input) ? input : []).map((item) => {
    const snippet = String(item.snippet || '').trim();
    let start = Math.max(0, Number(item.start) || 0);
    if (snippet && text.slice(start, start + snippet.length) !== snippet) {
      const matches = allIndexesOf(text, snippet);
      if (matches.length !== 1) return null;
      start = matches[0];
    }
    if (start < 0) return null;
    const end = snippet
      ? Math.min(text.length, start + snippet.length)
      : Math.min(text.length, Math.max(start + 1, Number(item.end) || start + 1));
    const type = allowed.has(item.type) ? item.type : null;
    if (!type) return null;
    const exactSnippet = text.slice(start, end);
    const correction = type === '错别字' ? normalizeWordCorrection(item.correction) : '';
    const reason = sanitizeAnnotationReason(type, String(item.reason || ''), correction);
    if (type === '错别字' && (exactSnippet.length < 2 || correction.length < 2)) return null;
    if (type !== '亮点' && exactSnippet.length < 2 && allIndexesOf(text, exactSnippet).length > 1) return null;
    if (type === '标点'
      && !/[，。！？；：,.!?;:]/.test(exactSnippet)
      && !/缺少|没有|未使用|补上|句末/.test(reason)) return null;
    if (isPinyinFormCorrection({ snippet: exactSnippet, type, reason })) return null;
    const tone = type === '亮点' ? 'positive' : type.endsWith('待核对') ? 'neutral' : 'issue';
    return { id: crypto.randomUUID(), start, end, snippet: exactSnippet, type, correction, reason, tone };
  }).filter((item) => item && item.start < text.length)
    .sort((a, b) => a.start - b.start || a.end - b.end || Number(Boolean(b.correction)) - Number(Boolean(a.correction)));

  const seenRanges = new Set();
  const seenTypo = new Set();
  let expressionReviewCount = 0;
  return annotations.map((item) => {
    const rangeKey = `${item.start}:${item.end}:${item.type}`;
    if (seenRanges.has(rangeKey)) return null;
    seenRanges.add(rangeKey);
    if (item.type === '表达待核对') {
      expressionReviewCount += 1;
      if (expressionReviewCount > 2) return null;
    }
    if (item.type !== '错别字') return item;
    const typoKey = `${item.snippet}:${item.correction}`;
    if (!seenTypo.has(typoKey)) {
      seenTypo.add(typoKey);
      return item;
    }
    return {
      ...item,
      correction: '',
      repeated: true,
      reason: '同一个词语前面已经提示过，这里按相同方式订正。',
    };
  }).filter(Boolean);
}

function needsOcrReview(text, annotations, textConfirmed) {
  const boxes = (String(text).match(/□/g) || []).length;
  if (boxes >= 2) return true;
  if (textConfirmed) return false;
  const recognitionReviews = (Array.isArray(annotations) ? annotations : [])
    .filter((item) => item?.type === '识别待核对').length;
  return recognitionReviews >= 2;
}

function hasReviewOutcome(value) {
  if (!value || typeof value !== 'object') return false;
  return value.reviewRequired === true
    || (Array.isArray(value.criteria) && value.criteria.some((item) => item?.status === 'review'));
}

function hasInvalidPositiveEvidence(value, criteria, text) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.criteria)) return false;
  return value.criteria.some((item) => {
    if (!['achieved', 'partial', 'highlight'].includes(item?.status) || item?.evidenceFound !== true) return false;
    const criterion = criteria.find((candidate) => candidate.id === item.criterionId);
    return !criterion || usableEvidenceParts(item, text, criterion.text, 3).length === 0;
  });
}

function normalizeWordCorrection(value) {
  const correction = String(value || '').trim().replace(/^[“”"'「」『』]+|[“”"'「」『』]+$/g, '');
  if (!correction || correction.length > 12 || /[\s，。！？；：,.!?;:\n\r]/.test(correction)) return '';
  return correction;
}

function sanitizeAnnotationReason(type, reason, correction = '') {
  const value = String(reason || '').trim();
  if (type === '错别字') {
    return correction ? `这里想写的是“${correction}”。` : '这里的用字需要订正。';
  }
  if (type === '识别待核对') return value || '这个位置的字迹无法可靠辨认，请对照作品图片核对。';
  if (type === '表达待核对') return value || '这里存在两种合理理解，并且会影响评价结果，请老师核对。';
  if (!/应(?:该)?(?:写成|改成)|可以写成|可改为|建议改为|可能想写/.test(value)) return value;
  return {
    标点: '这里的标点使用需要检查。',
    语病: '这里表达不够清楚，请读一读。',
    重复: '这里有重复表达，请读一读。',
    句子不完整: '这里的意思还没有表达完整。',
    图文不符: '这里与题图中能够确认的内容不一致。',
    亮点: value,
  }[type] || '这里需要再读一读。';
}

function normalizeTeacherReviewItems(annotations) {
  const output = [];
  const seen = new Set();
  for (const item of annotations) {
    if (item.tone !== 'neutral') continue;
    const key = `${item.type}:${item.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ type: item.type, snippet: item.snippet, reason: item.reason });
    if (output.length >= 3) break;
  }
  return output;
}

function filterSupportedAnnotations(annotations, results) {
  const evidence = results
    .filter((item) => ['achieved', 'highlight'].includes(item.status) && item.evidenceFound)
    .map((item) => item.evidence)
    .filter(Boolean);
  return annotations.filter((annotation) => annotation.tone !== 'positive'
    || evidence.some((value) => value.includes(annotation.snippet) || annotation.snippet.includes(value)));
}

function normalizeSupportedPositives(input, results, criteria, text, limit) {
  const supported = new Map(results
    .filter((item) => ['achieved', 'highlight'].includes(item.status) && item.evidenceFound)
    .map((item) => [item.criterionId, item]));
  const output = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue;
    const result = supported.get(item.criterionId);
    const criterion = criteria.find((candidate) => candidate.id === item.criterionId);
    const evidence = String(item.evidence || '').trim();
    const positiveText = String(item.text || '').trim();
    if (!result || !criterion || !positiveText) continue;
    if (evidence && (!text.includes(evidence) || !result.evidence.includes(evidence) && !evidence.includes(result.evidence))) continue;
    if (!output.includes(positiveText)) output.push(positiveText);
    if (output.length >= limit) break;
  }
  return output;
}

function allIndexesOf(text, snippet) {
  if (!snippet) return [];
  const indexes = [];
  let from = 0;
  while (from <= text.length - snippet.length) {
    const index = text.indexOf(snippet, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, snippet.length);
  }
  return indexes;
}

function normalizeStrings(input, limit) {
  return [...new Set((Array.isArray(input) ? input : []).map((item) => String(item).trim()).filter(Boolean))].slice(0, limit);
}

function normalizeFormatReview(input) {
  const source = input && typeof input === 'object' ? input : {};
  const available = source.available === true;
  const notes = available
    ? normalizeStrings(source.notes, 3).map((item) => item.slice(0, 120))
    : [];
  return {
    available,
    needsTeacherReview: available && source.needsTeacherReview === true,
    notes,
  };
}

function parseJson(value) {
  if (typeof value === 'object') return value;
  const cleaned = String(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 35 * 1024 * 1024) request.destroy(new Error('请求内容过大'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(badRequest('请求格式错误')); }
    });
    request.on('error', reject);
  });
}

function responseHeaders(request, extra = {}) {
  const origin = String(request?.headers?.origin || '');
  return {
    'Access-Control-Allow-Origin': origin && isOriginAllowed(request) ? origin : '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-App-Id, X-App-Client-Id',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'private, no-store',
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(response, status, payload, request, extraHeaders = {}) {
  response.writeHead(status, {
    ...responseHeaders(request, extraHeaders),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function send(response, status, body, request, extraHeaders = {}) {
  response.writeHead(status, responseHeaders(request, extraHeaders));
  response.end(body);
}

function isOriginAllowed(request) {
  const origin = String(request?.headers?.origin || '');
  return !origin || allowedOrigins.size === 0 || allowedOrigins.has(origin);
}

function isExpectedApp(request) {
  return String(request.headers['x-app-id'] || '') === publicAppId;
}

function isAuthorized(request) {
  if (!appPassword) return true;
  const header = String(request.headers.authorization || '');
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqual(username, appUsername) && safeEqual(password, appPassword);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function applyRateLimit(request) {
  if (!rateLimitMax) return 0;
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = forwarded || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateLimitBuckets.size > 500) {
    for (const [bucketKey, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey);
    }
  }
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return 0;
  }
  current.count += 1;
  if (current.count <= rateLimitMax) return 0;
  return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function providerError(message) {
  const error = new Error(message);
  error.status = 502;
  return error;
}

function healthStatus() {
  const providers = {
    vision: kimi.apiKey ? `kimi:${kimi.model}` : 'demo',
    text: deepseek.apiKey ? `deepseek:${deepseek.model}` : 'demo',
  };
  const mode = kimi.apiKey && deepseek.apiKey ? 'hybrid' : kimi.apiKey || deepseek.apiKey ? 'partial-demo' : 'demo';
  return {
    ok: true,
    appId: publicAppId,
    authRequired: Boolean(appPassword),
    mode,
    providers,
  };
}

function loadLocalEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].trim();
  }
}
