import axios from 'axios';

const api = axios.create({
  baseURL: 'https://ai-video.ldragon.xyz/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('userId');
      localStorage.removeItem('role');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const taskApi = {
  list: (params?: { status?: string; page?: number; limit?: number }) =>
    api.get('/tasks', { params }),
  get: (id: string) => api.get(`/tasks/${id}`),
  create: (data: any) => api.post('/tasks', data),
  update: (id: string, data: any) => api.put(`/tasks/${id}`, data),
  delete: (id: string) => api.delete(`/tasks/${id}`),
  start: (id: string) => api.post(`/tasks/${id}/start`),
  cancel: (id: string) => api.post(`/tasks/${id}/cancel`),
  retry: (id: string) => api.post(`/tasks/${id}/retry`),
  advance: (id: string) => api.post(`/tasks/${id}/advance`),
  restartPhase: (id: string) => api.post(`/tasks/${id}/restart-phase`),
};

export const accountApi = {
  listGitHub: () => api.get('/admin/accounts/github'),
  createGitHub: (data: any) => api.post('/admin/accounts/github', data),
  updateGitHub: (id: number, data: any) => api.put(`/admin/accounts/github/${id}`, data),
  deleteGitHub: (id: number) => api.delete(`/admin/accounts/github/${id}`),
  listAI: () => api.get('/admin/accounts/ai'),
  createAI: (data: any) => api.post('/admin/accounts/ai', data),
  updateAI: (id: number, data: any) => api.put(`/admin/accounts/ai/${id}`, data),
  deleteAI: (id: number) => api.delete(`/admin/accounts/ai/${id}`),
  checkAIHealth: (id: number) => api.post(`/admin/accounts/ai/${id}/health`),
};

export const configApi = {
  getAll: () => api.get('/admin/config'),
  get: (key: string) => api.get(`/admin/config/${key}`),
  update: (key: string, value: string) => api.put(`/admin/config/${key}`, { value }),
  create: (data: { key: string; value: string; description?: string }) =>
    api.post('/admin/config', data),
  delete: (key: string) => api.delete(`/admin/config/${key}`),
};

export const metricsApi = {
  getAll: () => api.get('/admin/metrics'),
};

export default api;