import { db } from "../prisma/db.js";
import { autoEnrollClass } from "../utils/enrollmentHelper.js";

export const getClasses = async (req, res) => {
  try {
    const classes = await db.orm.public.Class.all();

    res.status(200).json({
      success: true,
      data: classes,
    });
  } catch (error) {
    console.error("Error fetching classes:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch classes",
    });
  }
};

export const createClass = async (req, res) => {
  try {
    const {
      subjectId,
      facultyId,
      departmentId,
      semester,
      section,
      academicYear,
    } = req.body;

    if (
      !subjectId ||
      !facultyId ||
      !departmentId ||
      !semester ||
      !section ||
      !academicYear
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // Check subject
    const subjects = await db.orm.public.Subject.all();

    const subject = subjects.find((item) => item.id === Number(subjectId));

    if (!subject) {
      return res.status(404).json({
        success: false,
        message: "Subject not found",
      });
    }

    // Check faculty
    const faculty = await db.orm.public.Faculty.all();

    const selectedFaculty = faculty.find(
      (item) => item.id === Number(facultyId),
    );

    if (!selectedFaculty) {
      return res.status(404).json({
        success: false,
        message: "Faculty not found",
      });
    }

    // Check department
    const departments = await db.orm.public.Department.all();

    const department = departments.find(
      (item) => item.id === Number(departmentId),
    );

    if (!department) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Create class
    const newClass = await db.orm.public.Class.create({
      subjectId: Number(subjectId),
      facultyId: Number(facultyId),
      departmentId: Number(departmentId),
      semester: Number(semester),
      section,
      academicYear,
    });

    // Auto-enroll all eligible students into this newly created class
    await autoEnrollClass(newClass);

    res.status(201).json({
      success: true,
      message: "Class created successfully",
      data: newClass,
    });
  } catch (error) {
    console.error("Error creating class:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create class",
    });
  }
};

export const getFacultyClasses = async (req, res) => {
  try {
    const userId = Number(req.user.id);

    // Find the faculty linked to the logged-in user
    const facultyList = await db.orm.public.Faculty.all();

    const faculty = facultyList.find((item) => item.userId === userId);

    if (!faculty) {
      return res.status(404).json({
        success: false,
        message: "Faculty profile not found",
      });
    }

    // Get classes handled by this faculty
    const classes = await db.orm.public.Class.all();

    const facultyClasses = classes.filter(
      (item) => item.facultyId === faculty.id,
    );

    // Get subjects
    const subjects = await db.orm.public.Subject.all();

    // Get departments
    const departments = await db.orm.public.Department.all();

    const result = facultyClasses.map((classItem) => {
      const subject = subjects.find((item) => item.id === classItem.subjectId);

      const department = departments.find(
        (item) => item.id === classItem.departmentId,
      );

      return {
        id: classItem.id,
        semester: classItem.semester,
        section: classItem.section,
        academicYear: classItem.academicYear,
        subject: subject
          ? {
              id: subject.id,
              code: subject.code,
              name: subject.name,
              credits: subject.credits,
            }
          : null,
        department: department
          ? {
              id: department.id,
              name: department.name,
              code: department.code,
            }
          : null,
      };
    });

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching faculty classes:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch faculty classes",
    });
  }
};
export const getClassDetails = async (req, res) => {
  try {
    const userId = Number(req.user.id);
    const classId = Number(req.params.id);

    if (!Number.isInteger(classId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid class ID",
      });
    }

    // Find the logged-in faculty
    const facultyList = await db.orm.public.Faculty.all();

    const faculty = facultyList.find((item) => item.userId === userId);

    if (!faculty) {
      return res.status(404).json({
        success: false,
        message: "Faculty profile not found",
      });
    }

    // Find the class
    const classes = await db.orm.public.Class.all();

    const classItem = classes.find(
      (item) => item.id === classId && item.facultyId === faculty.id,
    );

    if (!classItem) {
      return res.status(404).json({
        success: false,
        message: "Class not found or not assigned to this faculty",
      });
    }

    // Find subject
    const subjects = await db.orm.public.Subject.all();

    const subject = subjects.find((item) => item.id === classItem.subjectId);

    // Find department
    const departments = await db.orm.public.Department.all();

    const department = departments.find(
      (item) => item.id === classItem.departmentId,
    );

    // Find enrolled students
    const enrollments = await db.orm.public.Enrollment.all();

    const classEnrollments = enrollments.filter(
      (item) => item.classId === classItem.id,
    );

    const students = await db.orm.public.Student.all();
    const users = await db.orm.public.User.all();

    const enrolledStudents = classEnrollments.map((enrollment) => {
      const student = students.find((item) => item.id === enrollment.studentId);

      const user = users.find((item) => item.id === student?.userId);

      return {
        enrollmentId: enrollment.id,
        studentId: student?.id ?? null,
        registerNumber: student?.registerNumber ?? null,
        name: user?.name ?? null,
        email: user?.email ?? null,
        semester: student?.semester ?? null,
        section: student?.section ?? null,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        id: classItem.id,
        semester: classItem.semester,
        section: classItem.section,
        academicYear: classItem.academicYear,
        subject: subject
          ? {
              id: subject.id,
              code: subject.code,
              name: subject.name,
              credits: subject.credits,
            }
          : null,
        department: department
          ? {
              id: department.id,
              name: department.name,
              code: department.code,
            }
          : null,
        students: enrolledStudents,
        totalStudents: enrolledStudents.length,
      },
    });
  } catch (error) {
    console.error("Error fetching class details:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch class details",
    });
  }
};