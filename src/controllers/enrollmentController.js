import { db } from "../prisma/db.js";
import { syncAllEnrollments } from "../utils/enrollmentHelper.js";

export const getEnrollments = async (req, res) => {
  try {
    const enrollments = await db.orm.public.Enrollment.all();

    res.status(200).json({
      success: true,
      data: enrollments,
    });
  } catch (error) {
    console.error("Error fetching enrollments:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch enrollments",
    });
  }
};

export const createEnrollment = async (req, res) => {
  try {
    const { studentId, classId } = req.body;

    if (!studentId || !classId) {
      return res.status(400).json({
        success: false,
        message: "Student ID and Class ID are required",
      });
    }

    // Check student
    const students = await db.orm.public.Student.all();

    const student = students.find((item) => item.id === Number(studentId));

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found",
      });
    }

    // Check class
    const classes = await db.orm.public.Class.all();

    const selectedClass = classes.find((item) => item.id === Number(classId));

    if (!selectedClass) {
      return res.status(404).json({
        success: false,
        message: "Class not found",
      });
    }

    // Check duplicate enrollment
    const enrollments = await db.orm.public.Enrollment.all();

    const alreadyEnrolled = enrollments.some(
      (enrollment) =>
        enrollment.studentId === Number(studentId) &&
        enrollment.classId === Number(classId),
    );

    if (alreadyEnrolled) {
      return res.status(409).json({
        success: false,
        message: "Student is already enrolled in this class",
      });
    }

    // Create enrollment
    const enrollment = await db.orm.public.Enrollment.create({
      studentId: Number(studentId),
      classId: Number(classId),
    });

    res.status(201).json({
      success: true,
      message: "Student enrolled successfully",
      data: enrollment,
    });
  } catch (error) {
    console.error("Error creating enrollment:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create enrollment",
    });
  }
};

export const syncEnrollments = async (req, res) => {
  try {
    const result = await syncAllEnrollments();
    return res.status(200).json({
      success: true,
      message: `Enrollment sync complete. Created ${result.totalEnrolled} new enrollment(s).`,
      data: result,
    });
  } catch (error) {
    console.error("Error syncing enrollments:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to sync enrollments",
    });
  }
};
