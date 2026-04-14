import cors from "cors";
import express, { Application, ErrorRequestHandler, Request, Response } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import apiRoutes from "./routes/index.js";

const app: Application = express();

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
  origin: env.FRONTEND_URL,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.get("/", (req: Request, res: Response) => {
  res.json({ status: "server is running good" });
});
app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.use("/api", apiRoutes);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Something went wrong" });
};

app.use(errorHandler);

const startServer = async () => {
  //await database();
  app.listen(env.PORT, () => {
    console.log(` Server is running on: ${env.BACKEND_URL}`);
  });
}

startServer();