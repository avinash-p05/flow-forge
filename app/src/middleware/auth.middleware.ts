import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../utils/auth.tokens.js';
import type { AuthUser } from '../types/auth.types.js';

declare global {
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

export const requireAuth = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
  const header = request.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const user = token ? await verifyToken(token) : null;
  if (!user) {
    response.status(401).json({ error: token ? 'Invalid or expired token' : 'Authentication required' });
    return;
  }
  request.user = user;
  next();
};
