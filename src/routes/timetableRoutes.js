import express from "express";

import {
  getTimetable,
  createTimetable,
} from "../controllers/timetableController.js";
import { authenticate } from "../middleware/authMiddleware.js";
import { authorize } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.get("/", getTimetable);
router.post("/", authenticate, authorize("ADMIN", "HOD"), createTimetable);

export default router;