import { demoAnalyze, demoGrade, demoOcr } from './demoAi.js';

const APP_ID = 'picture-writing-workbench-v1';
const AUTH_STORAGE_KEY = 'picture-writing-workbench-auth-v1';
const CLIENT_STORAGE_KEY = 'picture-writing-workbench-client-v1';
export const AUTH_REQUIRED_EVENT = 'picture-writing-workbench-auth-required';

function apiBaseUrl() {
  const runtime = window.__PICTURE_WRITING_WORKBENCH_CONFIG__?.apiBaseUrl;
  return String(runtime || import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
}

function apiUrl(path) {
  return `${apiBaseUrl()}${path}`;
}

function clientId() {
  let value = localStorage.getItem(CLIENT_STORAGE_KEY);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(CLIENT_STORAGE_KEY, value);
  }
  return value;
}

function requestHeaders(authorization = sessionStorage.getItem(AUTH_STORAGE_KEY) || '') {
  return {
    'Content-Type': 'application/json',
    'X-App-Id': APP_ID,
    'X-App-Client-Id': clientId(),
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

function basicAuthorization(password) {
  const bytes = new TextEncoder().encode(`teacher:${password}`);
  let binary = '';
  bytes.forEach((value) => { binary += String.fromCharCode(value); });
  return `Basic ${btoa(binary)}`;
}

async function parseResponse(response) {
  if (response.ok) return response.json();
  const raw = await response.text();
  let message = raw;
  try { message = JSON.parse(raw).error || raw; } catch { /* keep raw response */ }
  const error = new Error(message || `请求失败：${response.status}`);
  error.status = response.status;
  if (response.status === 401) {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
  throw error;
}

async function post(path, payload) {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120000),
  });
  return parseResponse(response);
}

function canUseDemoFallback(error) {
  return import.meta.env.DEV && !error?.status;
}

export async function serviceStatus() {
  const response = await fetch(apiUrl('/api/health'), {
    headers: { 'X-App-Id': APP_ID },
    signal: AbortSignal.timeout(10000),
  });
  return parseResponse(response);
}

export function hasStoredAccess() {
  return Boolean(sessionStorage.getItem(AUTH_STORAGE_KEY));
}

export async function validateStoredAccess() {
  const response = await fetch(apiUrl('/api/auth'), {
    method: 'POST',
    headers: requestHeaders(),
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  return parseResponse(response);
}

export async function authenticate(password) {
  const authorization = basicAuthorization(password);
  const response = await fetch(apiUrl('/api/auth'), {
    method: 'POST',
    headers: requestHeaders(authorization),
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  const result = await parseResponse(response);
  sessionStorage.setItem(AUTH_STORAGE_KEY, authorization);
  return result;
}

export function clearAccess() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

export async function analyzePicture(payload) {
  try {
    return await post('/api/analyze-picture', payload);
  } catch (error) {
    if (canUseDemoFallback(error)) return demoAnalyze({ grade: payload.grade, imageCount: payload.images.length });
    throw error;
  }
}

export async function recognizeText(payload) {
  try {
    return await post('/api/ocr', payload);
  } catch (error) {
    if (canUseDemoFallback(error)) return demoOcr();
    throw error;
  }
}

export async function gradeWriting(payload) {
  try {
    return await post('/api/grade', payload);
  } catch (error) {
    if (canUseDemoFallback(error)) return demoGrade(payload);
    throw error;
  }
}
