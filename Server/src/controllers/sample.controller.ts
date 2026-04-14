import { Request, Response } from "express";


export const sample = (req: Request, res: Response) => {
  res.json({ message: "This is a sample response from the controller." });
}