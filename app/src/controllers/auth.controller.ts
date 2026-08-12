import type { Request, Response } from 'express';
import {
  AuthValidationError,
  login,
  logout,
  refresh,
  register,
} from '../services/auth.service.js';

export const registerUser = async (request: Request, response: Response): Promise<void> => {
  try {
    const result = await register(request.body?.email, request.body?.password);
    if (!result) {
      response.status(409).json({ error: 'Email is already registered' });
      return;
    }
    response.status(201).json(result);
  } catch (error) {
    if (error instanceof AuthValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
};

export const loginUser = async (request: Request, response: Response): Promise<void> => {
  try {
    const result = await login(request.body?.email, request.body?.password);
    if (!result) {
      response.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    response.json(result);
  } catch (error) {
    if (error instanceof AuthValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
};

export const refreshTokens = async (request: Request, response: Response): Promise<void> => {
  const result = await refresh(request.body?.refreshToken);
  if (!result) {
    response.status(401).json({ error: 'Invalid or expired refresh token' });
    return;
  }
  response.json(result);
};

export const logoutUser = async (request: Request, response: Response): Promise<void> => {
  await logout(request.body?.refreshToken);
  response.status(204).send();
};
