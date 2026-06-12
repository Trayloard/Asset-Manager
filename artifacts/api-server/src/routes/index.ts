import { Router, type IRouter } from "express";
import healthRouter from "./health";
import aiRouter from "./ai";
import authRouter from "./auth";
import conversationsRouter from "./conversations";
import companionRouter from "./companion";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);
router.use(authRouter);
router.use(conversationsRouter);
router.use(companionRouter);

export default router;
