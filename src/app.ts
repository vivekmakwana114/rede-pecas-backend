import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { errorConverter, errorHandler } from './middlewares/error.js';
import { ApiError } from './utils/ApiError.js';

const app = express();

// Parse json request body
app.use(express.json());

// Enable cors
app.use(cors());

// api routes (each route module binds its own /v1/... prefix — see routes/index.ts)
app.use(routes);

// Send back 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(404, 'Endpoint not found.'));
});

// Convert error to ApiError, if needed
app.use(errorConverter);

// Global error handler middleware
app.use(errorHandler);

export default app;
