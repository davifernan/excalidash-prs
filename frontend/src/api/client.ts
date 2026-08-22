import axios from "axios";
import { getShareLinkToken } from "./shareToken";

export const API_URL = import.meta.env.VITE_API_URL || "/api";

export const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
});

api.interceptors.request.use((request) => {
  const shareToken = getShareLinkToken();
  if (shareToken) request.headers.set("X-Share-Token", shareToken);
  return request;
});

export { default as axios } from "axios";
export const isAxiosError = axios.isAxiosError;
