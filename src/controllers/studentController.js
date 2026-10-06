import { db } from "../prisma/db.js";
import bcrypt from "bcryptjs";
import {
  autoEnrollStudent,
  normalizeAcademicYear,
  normalizeSection,
} from "../utils/enrollmentHelper.js";

const getStudentIdFromUser = async (userId) => {
  const students = await db.orm.public.Student.all();

  const student = students.find((item) => item.userId === Number(userId));

  return student?.id ?? null;
};

export const getStudents = async (req, res) => {
  try {
    const students = await db.orm.public.Student.all();

    res.status(200).json({
      success: true,
      data: students,
    });
  } catch (error) {
    console.error("Error fetching students:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch students",
    });
  }
};

export const createStudent = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      registerNumber,
      departmentId,
      semester,
      section,
      academicYear,
    } = req.body;

    // Check required fields
    if (
      !name ||
      !email ||
      !password ||
      !registerNumber ||
      !departmentId ||
      !semester ||
      !section
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    // Check whether email already exists
    const existingUsers = await db.orm.public.User.all();

    const emailExists = existingUsers.some((user) => user.email === email);

    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    // Check whether register number already exists
    const existingStudents = await db.orm.public.Student.all();

    const registerExists = existingStudents.some(
      (student) => student.registerNumber === registerNumber,
    );

    if (registerExists) {
      return res.status(409).json({
        success: false,
        message: "Register number already exists",
      });
    }

    // Check department exists
    const department = await db.orm.public.Department.all();

    const selectedDepartment = department.find(
      (dept) => dept.id === Number(departmentId),
    );

    if (!selectedDepartment) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create User
    const user = await db.orm.public.User.create({
      name,
      email,
      passwordHash,
      role: "STUDENT",
      isActive: true,
    });

    // Create Student
    const student = await db.orm.public.Student.create({
      userId: user.id,
      registerNumber,
      departmentId: Number(departmentId),
      semester: Number(semester),
      section: normalizeSection(section),
      academicYear: normalizeAcademicYear(academicYear),
    });

    // Auto-enroll student into matching classes
    const enrollmentResult = await autoEnrollStudent(student);

    res.status(201).json({
      success: true,
      message: "Student created successfully",
      data: {
        user,
        student,
        enrollment: enrollmentResult,
      },
    });
  } catch (error) {
    console.error("Error creating student:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create student",
    });
  }
};

export const getStudentDashboard = async (req, res) => {
  try {
    const users = await db.orm.public.User.all();

    const user = users.find((item) => item.id === Number(req.user.id));

    if (!user || user.role !== "STUDENT") {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const students = await db.orm.public.Student.all();

    const student = students.find((item) => item.userId === user.id);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const departments = await db.orm.public.Department.all();

    const department = departments.find(
      (item) => item.id === student.departmentId,
    );

    res.status(200).json({
      success: true,
      data: {
        student: {
          id: student.id,
          registerNumber: student.registerNumber,
          name: user.name,
          email: user.email,
          department: department?.name ?? null,
          semester: student.semester,
          section: student.section,
          academicYear: student.academicYear,
        },
      },
    });
  } catch (error) {
    console.error("Student dashboard error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch student dashboard",
    });
  }
};

export const getStudentProfile = async (req, res) => {
  try {
    const users = await db.orm.public.User.all();

    const user = users.find((item) => item.id === Number(req.user.id));

    if (!user || user.role !== "STUDENT") {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const students = await db.orm.public.Student.all();

    const student = students.find((item) => item.userId === user.id);

    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const departments = await db.orm.public.Department.all();

    const department = departments.find(
      (item) => item.id === student.departmentId,
    );

    res.status(200).json({
      success: true,
      data: {
        id: student.id,
        registerNumber: student.registerNumber,
        name: user.name,
        email: user.email,
        department: department?.name ?? null,
        departmentCode: department?.code ?? null,
        semester: student.semester,
        section: student.section,
        academicYear: student.academicYear,
      },
    });
  } catch (error) {
    console.error("Student profile error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch student profile",
    });
  }
};

export const getStudentSubjects = async (req, res) => {
  try {
    const studentId = await getStudentIdFromUser(req.user.id);

    if (!studentId) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const enrollments = await db.orm.public.Enrollment.all();
    const classes = await db.orm.public.Class.all();
    const subjects = await db.orm.public.Subject.all();
    const faculty = await db.orm.public.Faculty.all();
    const users = await db.orm.public.User.all();

    const studentEnrollments = enrollments.filter(
      (item) => item.studentId === studentId,
    );

    const data = studentEnrollments.map((enrollment) => {
      const classItem = classes.find((item) => item.id === enrollment.classId);

      const subject = subjects.find((item) => item.id === classItem?.subjectId);

      const facultyItem = faculty.find(
        (item) => item.id === classItem?.facultyId,
      );

      const facultyUser = users.find((item) => item.id === facultyItem?.userId);

      return {
        enrollmentId: enrollment.id,
        classId: classItem?.id ?? null,
        subjectId: subject?.id ?? null,
        code: subject?.code ?? null,
        name: subject?.name ?? null,
        credits: subject?.credits ?? null,
        faculty: facultyUser?.name ?? null,
        semester: classItem?.semester ?? null,
        section: classItem?.section ?? null,
        academicYear: classItem?.academicYear ?? null,
      };
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Student subjects error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch student subjects",
    });
  }
};

export const getStudentSubjectDetails = async (req, res) => {
  try {
    const studentId = await getStudentIdFromUser(req.user.id);
    const subjectId = Number(req.params.id);

    if (!studentId) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    if (!subjectId) {
      return res.status(400).json({
        success: false,
        message: "Invalid subject ID",
      });
    }

    const enrollments = await db.orm.public.Enrollment.all();
    const classes = await db.orm.public.Class.all();
    const subjects = await db.orm.public.Subject.all();
    const faculty = await db.orm.public.Faculty.all();
    const users = await db.orm.public.User.all();
    const sessions = await db.orm.public.AttendanceSession.all();
    const attendance = await db.orm.public.Attendance.all();

    // Find classes where this student is enrolled
    const studentEnrollments = enrollments.filter(
      (item) => item.studentId === studentId,
    );

    const enrollment = studentEnrollments.find((item) => {
      const classItem = classes.find(
        (classItem) => classItem.id === item.classId,
      );

      return classItem?.subjectId === subjectId;
    });

    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: "Subject not found for this student",
      });
    }

    const classItem = classes.find((item) => item.id === enrollment.classId);

    const subject = subjects.find((item) => item.id === classItem?.subjectId);

    const facultyItem = faculty.find(
      (item) => item.id === classItem?.facultyId,
    );

    const facultyUser = users.find((item) => item.id === facultyItem?.userId);

    // Sessions belonging to this class
    const classSessions = sessions.filter(
      (item) => item.classId === classItem.id,
    );

    // Attendance records belonging to this student and these sessions
    const studentAttendance = attendance.filter(
      (item) =>
        item.studentId === studentId &&
        classSessions.some((session) => session.id === item.sessionId),
    );

    const totalClasses = classSessions.length;

    const present = studentAttendance.filter(
      (item) => item.status === "PRESENT",
    ).length;

    const absent = studentAttendance.filter(
      (item) => item.status === "ABSENT",
    ).length;

    const late = studentAttendance.filter(
      (item) => item.status === "LATE",
    ).length;

    const attendancePercentage =
      totalClasses > 0
        ? Number(((present / totalClasses) * 100).toFixed(2))
        : 0;

    res.status(200).json({
      success: true,
      data: {
        subject: {
          id: subject.id,
          code: subject.code,
          name: subject.name,
          credits: subject.credits,
        },
        faculty: facultyUser?.name ?? null,
        class: {
          id: classItem.id,
          semester: classItem.semester,
          section: classItem.section,
          academicYear: classItem.academicYear,
        },
        attendance: {
          totalClasses,
          present,
          absent,
          late,
          percentage: attendancePercentage,
        },
      },
    });
  } catch (error) {
    console.error("Student subject details error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch subject details",
    });
  }
};

export const getStudentTimetable = async (req, res) => {
  try {
    const studentId = await getStudentIdFromUser(req.user.id);

    if (!studentId) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const enrollments = await db.orm.public.Enrollment.all();
    const classes = await db.orm.public.Class.all();
    const timetables = await db.orm.public.Timetable.all();
    const subjects = await db.orm.public.Subject.all();
    const faculty = await db.orm.public.Faculty.all();
    const users = await db.orm.public.User.all();

    const studentEnrollments = enrollments.filter(
      (item) => item.studentId === studentId,
    );

    const data = [];

    for (const enrollment of studentEnrollments) {
      const classItem = classes.find((item) => item.id === enrollment.classId);

      if (!classItem) continue;

      const subject = subjects.find((item) => item.id === classItem.subjectId);

      const facultyItem = faculty.find(
        (item) => item.id === classItem.facultyId,
      );

      const facultyUser = users.find((item) => item.id === facultyItem?.userId);

      const classTimetable = timetables.filter(
        (item) => item.classId === classItem.id,
      );

      for (const timetable of classTimetable) {
        data.push({
          id: timetable.id,
          dayOfWeek: timetable.dayOfWeek,
          startTime: timetable.startTime,
          endTime: timetable.endTime,
          room: timetable.room,
          subject: {
            id: subject?.id ?? null,
            code: subject?.code ?? null,
            name: subject?.name ?? null,
          },
          faculty: facultyUser?.name ?? null,
          classId: classItem.id,
        });
      }
    }

    data.sort((a, b) => {
      if (a.dayOfWeek !== b.dayOfWeek) {
        return a.dayOfWeek - b.dayOfWeek;
      }

      return a.startTime.localeCompare(b.startTime);
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Student timetable error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch student timetable",
    });
  }
};

export const getStudentAttendance = async (req, res) => {
  try {
    const studentId = await getStudentIdFromUser(req.user.id);

    if (!studentId) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const enrollments = await db.orm.public.Enrollment.all();
    const classes = await db.orm.public.Class.all();
    const subjects = await db.orm.public.Subject.all();
    const sessions = await db.orm.public.AttendanceSession.all();
    const attendance = await db.orm.public.Attendance.all();

    const studentEnrollments = enrollments.filter(
      (item) => item.studentId === studentId,
    );

    const data = studentEnrollments.map((enrollment) => {
      const classItem = classes.find((item) => item.id === enrollment.classId);

      const subject = subjects.find((item) => item.id === classItem?.subjectId);

      const classSessions = sessions.filter(
        (session) => session.classId === classItem?.id,
      );

      const studentAttendance = attendance.filter(
        (item) =>
          item.studentId === studentId &&
          classSessions.some((session) => session.id === item.sessionId),
      );

      const totalClasses = classSessions.length;

      const present = studentAttendance.filter(
        (item) => item.status === "PRESENT",
      ).length;

      const absent = studentAttendance.filter(
        (item) => item.status === "ABSENT",
      ).length;

      const late = studentAttendance.filter(
        (item) => item.status === "LATE",
      ).length;

      const percentage =
        totalClasses > 0
          ? Number(((present / totalClasses) * 100).toFixed(2))
          : 0;

      return {
        subjectId: subject?.id ?? null,
        code: subject?.code ?? null,
        subject: subject?.name ?? null,
        totalClasses,
        present,
        absent,
        late,
        percentage,
      };
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Student attendance error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch student attendance",
    });
  }
};

export const getStudentAttendanceHistory = async (req, res) => {
  try {
    const studentId = await getStudentIdFromUser(req.user.id);

    if (!studentId) {
      return res.status(404).json({
        success: false,
        message: "Student profile not found",
      });
    }

    const attendance = await db.orm.public.Attendance.all();
    const sessions = await db.orm.public.AttendanceSession.all();
    const classes = await db.orm.public.Class.all();
    const subjects = await db.orm.public.Subject.all();

    const studentAttendance = attendance.filter(
      (item) => item.studentId === studentId,
    );

    const data = studentAttendance.map((record) => {
      const session = sessions.find((item) => item.id === record.sessionId);

      const classItem = classes.find((item) => item.id === session?.classId);

      const subject = subjects.find((item) => item.id === classItem?.subjectId);

      return {
        attendanceId: record.id,
        sessionId: record.sessionId,
        date: session?.sessionDate ?? null,
        markedAt: record.markedAt,
        status: record.status,
        source: record.source,
        subject: {
          id: subject?.id ?? null,
          code: subject?.code ?? null,
          name: subject?.name ?? null,
        },
      };
    });

    data.sort((a, b) => {
      if (!a.date || !b.date) return 0;
      return new Date(b.date) - new Date(a.date);
    });

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Student attendance history error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch attendance history",
    });
  }
};
