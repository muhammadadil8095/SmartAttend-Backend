import express from "express";

import {
  getEnrollments,
  createEnrollment,
  syncEnrollments,
} from "../controllers/enrollmentController.js";

const router = express.Router();

router.get("/", getEnrollments);
router.post("/", createEnrollment);
router.post("/sync", syncEnrollments);

export default router;
