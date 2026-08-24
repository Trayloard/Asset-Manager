import { Router, type IRouter } from "express";
import healthRouter from "./health";
<<<<<<< HEAD
import aiRouter from "./ai";
import authRouter from "./auth";
import conversationsRouter from "./conversations";
import companionRouter from "./companion";
=======
import authRouter from "./auth";
import companionRouter from "./companion";
import voiceRouter from "./voice";
>>>>>>> origin/main

const router: IRouter = Router();

router.use(healthRouter);
<<<<<<< HEAD
router.use(aiRouter);
router.use(authRouter);
router.use(conversationsRouter);
router.use(companionRouter);
=======
router.use(authRouter);
router.use(companionRouter);
router.use(voiceRouter);
>>>>>>> origin/main

export default router;
