import { db } from "../prisma/db.js";

/**
 * Normalizes section strings (e.g. "Section A", "A", " a " -> "A")
 */
export function normalizeSection(sec) {
  if (!sec) return "A";
  return String(sec).replace(/section/i, "").trim().toUpperCase() || "A";
}

/**
 * Normalizes academic year strings into the canonical "YYYY-YYYY" format.
 *
 * Examples:
 *   "2026-27"    -> "2026-2027"
 *   "2025-2026"  -> "2025-2026"
 *   "2025-26"    -> "2025-2026"
 *   "2026/2027"  -> "2026-2027"
 *   "2026"       -> "2026-2027"
 *   null / ""    -> dynamically derives current year based on month (e.g., "2026-2027" or "2025-2026")
 *
 * @param {string|null|undefined} raw
 * @returns {string} Normalized "YYYY-YYYY" string
 */
export function normalizeAcademicYear(raw) {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed (0 = Jan, 6 = Jul)
    // Academic year runs ~July to June; before July belongs to prior year
    const startYear = currentMonth >= 6 ? currentYear : currentYear - 1;
    return `${startYear}-${startYear + 1}`;
  }

  const trimmed = raw.trim();

  // Pattern: "YYYY-YYYY" or "YYYY/YYYY" (e.g. 2025-2026, 2026/2027)
  const fullYearMatch = trimmed.match(/^(\d{4})[-/](\d{4})$/);
  if (fullYearMatch) {
    return `${fullYearMatch[1]}-${fullYearMatch[2]}`;
  }

  // Pattern: "YYYY-YY" or "YYYY/YY" (e.g. 2026-27, 2025/26)
  const shortYearMatch = trimmed.match(/^(\d{4})[-/](\d{2})$/);
  if (shortYearMatch) {
    const startYear = parseInt(shortYearMatch[1], 10);
    const shortEnd = parseInt(shortYearMatch[2], 10);
    const century = Math.floor(startYear / 100) * 100;
    const fullEndYear = century + shortEnd;
    return `${startYear}-${fullEndYear}`;
  }

  // Pattern: Single 4-digit year (e.g. "2026")
  const singleYearMatch = trimmed.match(/^(\d{4})$/);
  if (singleYearMatch) {
    const startYear = parseInt(singleYearMatch[1], 10);
    return `${startYear}-${startYear + 1}`;
  }

  return trimmed;
}

/**
 * Auto-enrolls a single student into all matching classes for their department, semester, and section.
 *
 * @param {Object} student - Student record { id, departmentId, semester, section, academicYear }
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ enrolledCount: number, classIds: number[] }>}
 */
export async function autoEnrollStudent(student, dbClient = db) {
  if (!student || !student.id) {
    console.warn("[AutoEnroll] autoEnrollStudent called with missing student or student.id");
    return { enrolledCount: 0, classIds: [] };
  }

  try {
    const studentSec = normalizeSection(student.section);
    const studentSem = Number(student.semester);
    const studentDeptId = Number(student.departmentId);
    const studentYear = normalizeAcademicYear(student.academicYear);

    console.log(
      `[AutoEnroll] autoEnrollStudent: student ${student.id} (${student.registerNumber || student.usn || "N/A"}) | ` +
      `dept=${studentDeptId} sem=${studentSem} sec=${studentSec} year=${studentYear}`,
    );

    // Fetch classes matching this student's department, semester, section, and normalized academic year
    const allClasses = await dbClient.orm.public.Class.all();
    const matchingClasses = allClasses.filter((cls) => {
      const clsDeptId = Number(cls.departmentId);
      const clsSem = Number(cls.semester);
      const clsSec = normalizeSection(cls.section);
      const clsYear = normalizeAcademicYear(cls.academicYear);

      return (
        clsDeptId === studentDeptId &&
        clsSem === studentSem &&
        clsSec === studentSec &&
        clsYear === studentYear
      );
    });

    if (matchingClasses.length === 0) {
      console.warn(
        `[AutoEnroll] No matching classes found for student ${student.id} ` +
        `(dept=${studentDeptId}, sem=${studentSem}, sec=${studentSec}, year=${studentYear}). ` +
        `Total classes in DB: ${allClasses.length}.`,
      );
      return { enrolledCount: 0, classIds: [] };
    }

    // Fetch existing enrollments for this student
    const allEnrollments = await dbClient.orm.public.Enrollment.where({
      studentId: student.id,
    }).all();
    const enrolledClassIds = new Set(allEnrollments.map((e) => Number(e.classId)));

    const newlyEnrolledClassIds = [];

    for (const cls of matchingClasses) {
      if (!enrolledClassIds.has(Number(cls.id))) {
        await dbClient.orm.public.Enrollment.create({
          studentId: student.id,
          classId: cls.id,
        });

        enrolledClassIds.add(Number(cls.id));
        newlyEnrolledClassIds.push(cls.id);
      }
    }

    if (newlyEnrolledClassIds.length > 0) {
      console.log(
        `[AutoEnroll] Successfully enrolled student ${student.id} into ` +
        `${newlyEnrolledClassIds.length} class(es): [${newlyEnrolledClassIds.join(", ")}]`,
      );
    } else {
      console.log(
        `[AutoEnroll] Student ${student.id} already enrolled in all ${matchingClasses.length} matching class(es).`,
      );
    }

    return {
      enrolledCount: newlyEnrolledClassIds.length,
      classIds: newlyEnrolledClassIds,
    };
  } catch (err) {
    console.error(
      `[AutoEnroll] FATAL error enrolling student ID ${student?.id}:`,
      err,
    );
    throw err;
  }
}

/**
 * Bulk auto-enrolls multiple students into all matching classes.
 *
 * @param {Array<Object>} students
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ totalEnrolled: number }>}
 */
export async function autoEnrollStudents(students, dbClient = db) {
  if (!Array.isArray(students) || students.length === 0) {
    return { totalEnrolled: 0 };
  }

  try {
    const allClasses = await dbClient.orm.public.Class.all();
    const allEnrollments = await dbClient.orm.public.Enrollment.all();

    const enrollmentSet = new Set(
      allEnrollments.map((e) => `${e.studentId}_${e.classId}`),
    );

    let totalEnrolled = 0;

    for (const student of students) {
      if (!student || !student.id) continue;

      const studentSec = normalizeSection(student.section);
      const studentSem = Number(student.semester);
      const studentDeptId = Number(student.departmentId);
      const studentYear = normalizeAcademicYear(student.academicYear);

      const matchingClasses = allClasses.filter((cls) => {
        const clsDeptId = Number(cls.departmentId);
        const clsSem = Number(cls.semester);
        const clsSec = normalizeSection(cls.section);
        const clsYear = normalizeAcademicYear(cls.academicYear);

        return (
          clsDeptId === studentDeptId &&
          clsSem === studentSem &&
          clsSec === studentSec &&
          clsYear === studentYear
        );
      });

      for (const cls of matchingClasses) {
        const key = `${student.id}_${cls.id}`;
        if (!enrollmentSet.has(key)) {
          await dbClient.orm.public.Enrollment.create({
            studentId: student.id,
            classId: cls.id,
          });

          enrollmentSet.add(key);
          totalEnrolled++;
        }
      }
    }

    console.log(
      `[AutoEnroll] Bulk enrolled ${students.length} student(s) with ${totalEnrolled} new class enrollment(s).`,
    );

    return { totalEnrolled };
  } catch (err) {
    console.error("[AutoEnroll] FATAL error in bulk autoEnrollStudents:", err);
    throw err;
  }
}

/**
 * Auto-enrolls all eligible students into a newly created class.
 *
 * @param {Object} classItem - Class record { id, departmentId, semester, section, academicYear }
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ enrolledCount: number, studentIds: number[] }>}
 */
export async function autoEnrollClass(classItem, dbClient = db) {
  if (!classItem || !classItem.id) return { enrolledCount: 0, studentIds: [] };

  try {
    const clsSec = normalizeSection(classItem.section);
    const clsSem = Number(classItem.semester);
    const clsDeptId = Number(classItem.departmentId);
    const clsYear = normalizeAcademicYear(classItem.academicYear);

    console.log(
      `[AutoEnroll] autoEnrollClass: class ${classItem.id} | dept=${clsDeptId} sem=${clsSem} sec=${clsSec} year=${clsYear}`,
    );

    // Fetch all students matching department, semester, section, and academic year
    const allStudents = await dbClient.orm.public.Student.all();
    const matchingStudents = allStudents.filter((st) => {
      const stDeptId = Number(st.departmentId);
      const stSem = Number(st.semester);
      const stSec = normalizeSection(st.section);
      const stYear = normalizeAcademicYear(st.academicYear);

      return (
        stDeptId === clsDeptId &&
        stSem === clsSem &&
        stSec === clsSec &&
        stYear === clsYear
      );
    });

    if (matchingStudents.length === 0) {
      console.warn(
        `[AutoEnroll] No students found for class ${classItem.id} | dept=${clsDeptId} sem=${clsSem} sec=${clsSec} year=${clsYear}. ` +
        `Total students in DB: ${allStudents.length}.`,
      );
      return { enrolledCount: 0, studentIds: [] };
    }

    // Fetch existing enrollments for this class
    const existingEnrollments = await dbClient.orm.public.Enrollment.where({
      classId: classItem.id,
    }).all();
    const enrolledStudentIds = new Set(
      existingEnrollments.map((e) => Number(e.studentId)),
    );

    const newlyEnrolledStudentIds = [];

    for (const st of matchingStudents) {
      if (!enrolledStudentIds.has(Number(st.id))) {
        await dbClient.orm.public.Enrollment.create({
          studentId: st.id,
          classId: classItem.id,
        });

        enrolledStudentIds.add(Number(st.id));
        newlyEnrolledStudentIds.push(st.id);
      }
    }

    if (newlyEnrolledStudentIds.length > 0) {
      console.log(
        `[AutoEnroll] Enrolled ${newlyEnrolledStudentIds.length} student(s) into class ID ${classItem.id}: [${newlyEnrolledStudentIds.join(", ")}]`,
      );
    } else {
      console.log(
        `[AutoEnroll] Class ${classItem.id}: all ${matchingStudents.length} matching student(s) already enrolled.`,
      );
    }

    return {
      enrolledCount: newlyEnrolledStudentIds.length,
      studentIds: newlyEnrolledStudentIds,
    };
  } catch (err) {
    console.error(
      `[AutoEnroll] FATAL error enrolling class ID ${classItem?.id}:`,
      err,
    );
    throw err;
  }
}

/**
 * Scans the whole database and ensures every student is enrolled into all matching classes.
 * Useful for automated healing and one-time sync.
 *
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ totalEnrolled: number, totalNoMatch: number, missingBySemester: Record<string, number> }>}
 */
export async function syncAllEnrollments(dbClient = db) {
  try {
    const allStudents = await dbClient.orm.public.Student.all();
    const allClasses = await dbClient.orm.public.Class.all();
    const allEnrollments = await dbClient.orm.public.Enrollment.all();

    const enrollmentSet = new Set(
      allEnrollments.map((e) => `${e.studentId}_${e.classId}`),
    );

    let totalEnrolled = 0;
    let totalNoMatch = 0;
    const missingBySemester = {};

    for (const student of allStudents) {
      if (!student || !student.id) continue;

      const studentSec = normalizeSection(student.section);
      const studentSem = Number(student.semester);
      const studentDeptId = Number(student.departmentId);
      const studentYear = normalizeAcademicYear(student.academicYear);

      const matchingClasses = allClasses.filter((cls) => {
        const clsDeptId = Number(cls.departmentId);
        const clsSem = Number(cls.semester);
        const clsSec = normalizeSection(cls.section);
        const clsYear = normalizeAcademicYear(cls.academicYear);

        return (
          clsDeptId === studentDeptId &&
          clsSem === studentSem &&
          clsSec === studentSec &&
          clsYear === studentYear
        );
      });

      if (matchingClasses.length === 0) {
        totalNoMatch++;
      }

      for (const cls of matchingClasses) {
        const key = `${student.id}_${cls.id}`;
        if (!enrollmentSet.has(key)) {
          await dbClient.orm.public.Enrollment.create({
            studentId: student.id,
            classId: cls.id,
          });

          enrollmentSet.add(key);
          totalEnrolled++;
          missingBySemester[studentSem] =
            (missingBySemester[studentSem] || 0) + 1;
        }
      }
    }

    if (totalEnrolled > 0) {
      console.log(
        `[AutoEnroll] syncAllEnrollments: created ${totalEnrolled} missing enrollment(s).`,
        missingBySemester,
      );
    } else {
      console.log(
        `[AutoEnroll] syncAllEnrollments: all students already fully enrolled. ` +
        `(${totalNoMatch} student(s) had no matching class at all.)`,
      );
    }

    return { totalEnrolled, totalNoMatch, missingBySemester };
  } catch (err) {
    console.error("[AutoEnroll] FATAL error during syncAllEnrollments:", err);
    throw err;
  }
}

/**
 * Sync enrollments for a single student (e.g. when their semester, section, or department changes).
 *
 * @param {Object} student - Student record
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ success: boolean, matchingClasses: number, enrolledCount: number, removedCount: number }>}
 */
export async function syncStudentEnrollments(student, dbClient = db) {
  try {
    const studentDeptId = Number(student.departmentId);
    const studentSem = Number(student.semester);
    const studentSec = normalizeSection(student.section);
    const studentYear = normalizeAcademicYear(student.academicYear);

    console.log(
      `[AutoEnroll] syncStudentEnrollments: student ${student.id} | dept=${studentDeptId} sem=${studentSem} sec=${studentSec} year=${studentYear}`,
    );

    const allClasses = await dbClient.orm.public.Class.all();

    const matchingClasses = allClasses.filter((cls) => {
      const clsDeptId = Number(cls.departmentId);
      const clsSem = Number(cls.semester);
      const clsSec = normalizeSection(cls.section);
      const clsYear = normalizeAcademicYear(cls.academicYear);

      return (
        clsDeptId === studentDeptId &&
        clsSem === studentSem &&
        clsSec === studentSec &&
        clsYear === studentYear
      );
    });

    if (matchingClasses.length === 0) {
      console.warn(
        `[AutoEnroll] syncStudentEnrollments: no matching classes for student ${student.id}. ` +
        `Searched: dept=${studentDeptId} sem=${studentSem} sec=${studentSec} year=${studentYear}. ` +
        `Total classes in DB: ${allClasses.length}.`,
      );
    }

    const existingEnrollments = await dbClient.orm.public.Enrollment.where({
      studentId: student.id,
    }).all();

    const matchingClassIds = new Set(
      matchingClasses.map((cls) => Number(cls.id)),
    );

    // Remove enrollments for classes that no longer match (e.g. section/semester changed)
    let removedCount = 0;
    for (const enrollment of existingEnrollments) {
      if (!matchingClassIds.has(Number(enrollment.classId))) {
        await dbClient.orm.public.Enrollment.where({
          id: enrollment.id,
        }).delete();
        removedCount++;
      }
    }

    const currentEnrolledClassIds = new Set(
      existingEnrollments
        .filter((e) => matchingClassIds.has(Number(e.classId)))
        .map((e) => Number(e.classId)),
    );

    let enrolledCount = 0;

    for (const cls of matchingClasses) {
      if (!currentEnrolledClassIds.has(Number(cls.id))) {
        await dbClient.orm.public.Enrollment.create({
          studentId: student.id,
          classId: cls.id,
        });

        enrolledCount++;
      }
    }

    console.log(
      `[AutoEnroll] syncStudentEnrollments: student ${student.id} -> ` +
      `${matchingClasses.length} matching class(es), ${enrolledCount} new, ${removedCount} removed.`,
    );

    return {
      success: true,
      matchingClasses: matchingClasses.length,
      enrolledCount,
      removedCount,
    };
  } catch (error) {
    console.error(`[AutoEnroll] FATAL error syncing enrollments for student ${student?.id}:`, error);
    throw error;
  }
}
