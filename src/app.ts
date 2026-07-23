import express from 'express';
import cors from 'cors';
import routes from './routes/v1/index.js';
import { errorConverter, errorHandler } from './middlewares/error.js';
import { ApiError } from './utils/ApiError.js';

const app = express();

app.use(express.json());

app.use(cors());

app.use('/v1', routes);

app.use((req, res, next) => {
  next(new ApiError(404, 'Endpoint not found.'));
});

app.use(errorConverter);

app.use(errorHandler);

export default app;
