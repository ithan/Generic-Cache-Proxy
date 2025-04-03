import express from 'express';
import { proxyController } from '../controllers/proxy.controller';

const router = express.Router();

// Catch-all route to handle all requests
router.all('*', proxyController.handleRequest.bind(proxyController));

export const proxyRoutes = router;
