import { useEffect, useRef, useState } from 'react';
import TaskList from './components/TaskList.jsx';
import TaskEditor from './components/TaskEditor.jsx';
import Workbench from './components/Workbench.jsx';
import ToastStack from './components/Toast.jsx';
import { createTask, uid } from './lib/defaults.js';
import { getTask, listTasks, putTask, removeTask } from './lib/storage.js';

function routeFromHash() {
  const value = window.location.hash.replace(/^#\/?/, '');
  if (value.startsWith('task/')) return { page: 'task', id: value.split('/')[1] };
  if (value.startsWith('edit/')) return { page: 'edit', id: value.split('/')[1] };
  return { page: 'list' };
}

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [tasks, setTasks] = useState([]);
  const [currentTask, setCurrentTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState([]);
  const currentRef = useRef(null);

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      if (route.page === 'list') {
        const all = await listTasks();
        if (active) {
          setTasks(all);
          setCurrentTask(null);
          currentRef.current = null;
        }
      } else {
        const task = await getTask(route.id);
        if (active) {
          if (task) {
            setCurrentTask(task);
            currentRef.current = task;
          } else {
            window.location.hash = '#/';
          }
        }
      }
      if (active) setLoading(false);
    }
    load();
    return () => { active = false; };
  }, [route.page, route.id]);

  function navigate(value) {
    window.location.hash = value;
  }

  function notify(title, message = '', tone = 'success') {
    const id = uid('toast');
    setToasts((items) => [...items, { id, title, message, tone }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  }

  function updateTask(taskId, change) {
    const base = currentRef.current?.id === taskId ? currentRef.current : null;
    if (base) {
      const next = typeof change === 'function' ? change(base) : change;
      currentRef.current = next;
      setCurrentTask(next);
      putTask(next).then((saved) => {
        if (currentRef.current?.id === taskId && new Date(saved.updatedAt) >= new Date(currentRef.current.updatedAt || 0)) {
          currentRef.current = { ...currentRef.current, updatedAt: saved.updatedAt };
        }
      });
      return;
    }
    getTask(taskId).then((stored) => {
      if (!stored) return;
      const next = typeof change === 'function' ? change(stored) : change;
      return putTask(next);
    });
  }

  function createNew() {
    const task = createTask();
    currentRef.current = task;
    setCurrentTask(task);
    putTask(task).then(() => navigate(`#/edit/${task.id}`));
  }

  async function openTask(task) {
    navigate(task.standardsConfirmed ? `#/task/${task.id}` : `#/edit/${task.id}`);
  }

  async function renameTask(task) {
    const name = window.prompt('修改任务名称', task.name || '')?.trim();
    if (!name) return;
    await putTask({ ...task, name });
    setTasks(await listTasks());
  }

  async function deleteTask(task) {
    const approved = window.confirm(`确定永久删除“${task.name || '未命名任务'}”吗？该任务下的图片、原文和批改结果都无法恢复。`);
    if (!approved) return;
    await removeTask(task.id);
    setTasks((items) => items.filter((item) => item.id !== task.id));
    notify('任务已删除', '该任务的数据已从当前浏览器中移除。');
  }

  async function finishEditor(next) {
    const wasConfirmed = next.standardsConfirmed && currentRef.current?.standardsConfirmed;
    currentRef.current = next;
    setCurrentTask(next);
    await putTask(next);
    notify(wasConfirmed ? '评价标准已保存' : '任务已创建');
    navigate(`#/task/${next.id}`);
  }

  if (loading) {
    return <div className="app-loading"><span className="large-spinner" /><p>正在打开工作台…</p></div>;
  }

  return (
    <>
      {route.page === 'list' && (
        <TaskList tasks={tasks} onCreate={createNew} onOpen={openTask} onRename={renameTask} onDelete={deleteTask} />
      )}
      {route.page === 'edit' && currentTask && (
        <TaskEditor
          task={currentTask}
          onChange={(change) => updateTask(currentTask.id, change)}
          onBack={() => navigate(currentTask.standardsConfirmed ? `#/task/${currentTask.id}` : '#/')}
          onFinish={finishEditor}
          notify={notify}
        />
      )}
      {route.page === 'task' && currentTask && (
        <Workbench
          task={currentTask}
          onChange={(change) => updateTask(currentTask.id, change)}
          onBack={() => navigate('#/')}
          onSettings={() => navigate(`#/edit/${currentTask.id}`)}
          notify={notify}
        />
      )}
      <ToastStack items={toasts} dismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    </>
  );
}
