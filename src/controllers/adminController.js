import { db } from "../prisma/db.js";
import bcrypt from "bcryptjs";
import {
  autoEnrollStudent,
  normalizeAcademicYear,
  normalizeSection,
} from "../utils/enrollmentHelper.js";

export const getAdminDashboard = async (req, res) => {
  try {
    const students = await db.orm.public.Student.all();
    const faculty = await db.orm.public.Faculty.all();
    const classes = await db.orm.public.Class.all();
    const sessions = await db.orm.public.AttendanceSession.all();
    const attendance = await db.orm.public.Attendance.all();

    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split("T")[0];

    const todaySessions = sessions.filter((session) =>
      String(session.sessionDate).startsWith(today),
    );

    const activeSessions = todaySessions.filter(
      (session) => session.endedAt === null,
    );

    const todayAttendance = attendance.filter((record) =>
      String(record.markedAt).startsWith(today),
    );

    const presentToday = todayAttendance.filter(
      (record) => record.status === "PRESENT",
    ).length;

    const absentToday = todayAttendance.filter(
      (record) => record.status === "ABSENT",
    ).length;

    return res.status(200).json({
      success: true,
      data: {
        totalStudents: students.length,
        totalFaculty: faculty.length,
        totalClasses: classes.length,
        activeSessions: activeSessions.length,
        todaySessions: todaySessions.length,
        todayAttendance: todayAttendance.length,
        presentToday,
        absentToday,
      },
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load admin dashboard",
    });
  }
};

export const getAdminStudents = async (req, res) => {
  try {
    const students = await db.orm.public.Student.all();
    const users = await db.orm.public.User.all();
    const departments = await db.orm.public.Department.all();
    const devices = await db.orm.public.StudentDevice.all();

    const result = students.map((student) => {
      const user = users.find((user) => user.id === student.userId);

      const department = departments.find(
        (department) => department.id === student.departmentId,
      );

      const studentDevices = devices.filter(
        (device) => device.studentId === student.id && device.isActive === true,
      );

      const deviceBound = studentDevices.length > 0;

      return {
        id: student.id,
        name: user?.name ?? "Unknown",
        usn: student.registerNumber,
        department: department?.name ?? "Unknown",
        semester: student.semester,
        section: student.section,
        academicYear: student.academicYear,
        email: user?.email ?? null,
        deviceBound,
        boundDeviceName: deviceBound ? "Registered Device" : null,
      };
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Admin students error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to load students",
    });
  }
};

export const createAdminStudent = async (req, res) => {
  try {
    const {
      name,
      email,
      registerNumber,
      department,
      departmentId,
      semester,
      section,
      academicYear,
    } = req.body;

    // Basic validation
    if (!name || !email || !registerNumber) {
      return res.status(400).json({
        success: false,
        message: "Name, email and register number are required",
      });
    }

    // Find department
    const departments = await db.orm.public.Department.all();

    let selectedDepartment = null;

    if (departmentId) {
      selectedDepartment = departments.find(
        (item) => item.id === Number(departmentId),
      );
    } else if (department) {
      selectedDepartment = departments.find(
        (item) =>
          item.name.toLowerCase() === String(department).trim().toLowerCase() ||
          item.code.toLowerCase() === String(department).trim().toLowerCase(),
      );
    }

    if (!selectedDepartment) {
      return res.status(404).json({
        success: false,
        message: "Department not found",
      });
    }

    // Convert semester if necessary
    const semesterNumber = Number(String(semester ?? "").replace(/\D/g, ""));

    if (!semesterNumber || semesterNumber < 1 || semesterNumber > 8) {
      return res.status(400).json({
        success: false,
        message: "Semester must be between 1 and 8",
      });
    }

    // Normalize values
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedRegisterNumber = String(registerNumber)
      .trim()
      .toUpperCase();

    // Check duplicate email
    const users = await db.orm.public.User.all();

    const emailExists = users.some(
      (user) => user.email.toLowerCase() === normalizedEmail,
    );

    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: "Email already exists",
      });
    }

    // Check duplicate USN
    const students = await db.orm.public.Student.all();

    const registerExists = students.some(
      (student) =>
        student.registerNumber.toUpperCase() === normalizedRegisterNumber,
    );

    if (registerExists) {
      return res.status(409).json({
        success: false,
        message: "Register number already exists",
      });
    }

    // Generate temporary password
    const temporaryPassword = `SA${normalizedRegisterNumber.slice(-4)}@2026`;

    const passwordHash = await bcrypt.hash(temporaryPassword, 10);

    // Create User
    const user = await db.orm.public.User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
      role: "STUDENT",
      isActive: true,
    });

    // Create Student
    const student = await db.orm.public.Student.create({
      userId: user.id,
      registerNumber: normalizedRegisterNumber,
      departmentId: selectedDepartment.id,
      semester: semesterNumber,
      section: normalizeSection(section),
      academicYear: normalizeAcademicYear(academicYear),
    });

    // Automatically enroll student into matching classes
    const enrollmentResult = await autoEnrollStudent(student);

    return res.status(201).json({
      success: true,
      message: "Student account created successfully",
      data: {
        id: student.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        usn: student.registerNumber,
        department: selectedDepartment.name,
        departmentId: selectedDepartment.id,
        semester: student.semester,
        section: student.section,
        academicYear: student.academicYear,
        deviceBound: false,

        // Enrollment information
        enrollment: enrollmentResult,

        // Temporary for development/testing.
        // Remove this before production.
        temporaryPassword,
      },
    });
  } catch (error) {
    console.error("Admin create student error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create student account",
    });
  }
};
