import express from "express";

import {
  getClasses,
  createClass,
  getClassDetails,
} from "../controllers/classController.js";

import { authenticate } from "../middleware/authMiddleware.js";
import { authorize } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.get("/", getClasses);
router.post("/", authenticate, authorize("ADMIN", "HOD"), createClass);
router.get("/:id", authenticate, authorize("FACULTY", "ADMIN", "HOD"), getClassDetails);

export default router;