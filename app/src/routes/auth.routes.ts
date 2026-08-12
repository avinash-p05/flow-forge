import { Router } from 'express';
import {
  loginUser,
  logoutUser,
  refreshTokens,
  registerUser,
} from '../controllers/auth.controller.js';

export const authRouter = Router();
authRouter.post('/register', registerUser);
authRouter.post('/login', loginUser);
authRouter.post('/refresh', refreshTokens);
authRouter.post('/logout', logoutUser);
