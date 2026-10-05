import { db } from "../prisma/db.js";

/**
 * Normalizes section strings (e.g. "Section A", "A", " a " -> "A")
 */
function normalizeSection(sec) {
    if (!sec) return "A";
    return String(sec).replace(/section/i, "").trim().toUpperCase() || "A";
}

/**
 * Auto-enrolls a single student into all matching classes for their department, semester, and section.
 *
 * @param {Object} student - Student record { id, departmentId, semester, section }
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ enrolledCount: number, classIds: number[] }>}
 */
export async function autoEnrollStudent(student, dbClient = db) {
    if (!student || !student.id) return { enrolledCount: 0, classIds: [] };

    try {
        const studentSec = normalizeSection(student.section);
        const studentSem = Number(student.semester);
        const studentDeptId = Number(student.departmentId);

        // Fetch classes matching this student's department and semester
        const allClasses = await dbClient.orm.public.Class.all();
        const matchingClasses = allClasses.filter((cls) => {
            const clsDeptId = Number(cls.departmentId);
            const clsSem = Number(cls.semester);
            const clsSec = normalizeSection(cls.section);

            const clsAcademicYear = String(cls.academicYear ?? "").trim();
            const studentAcademicYear = String(student.academicYear ?? "").trim();

            return (
                clsDeptId === studentDeptId &&
                clsSem === studentSem &&
                clsSec === studentSec &&
                clsAcademicYear === studentAcademicYear
            );
        });

        if (matchingClasses.length === 0) {
            return { enrolledCount: 0, classIds: [] };
        }

        // Fetch existing enrollments for this student
        const allEnrollments = await dbClient.orm.public.Enrollment.where({
            studentId: student.id,
        }).all();
        const enrolledClassIds = new Set(allEnrollments.map((e) => e.classId));

        const newlyEnrolledClassIds = [];

        for (const cls of matchingClasses) {
            if (!enrolledClassIds.has(cls.id)) {
                await dbClient.orm.public.Enrollment.create({
                    studentId: student.id,
                    classId: cls.id,
                });

                enrolledClassIds.add(cls.id);
                newlyEnrolledClassIds.push(cls.id);
            }
        }

        if (newlyEnrolledClassIds.length > 0) {
            console.log(
                `[AutoEnroll] Enrolled student ID ${student.id} (${student.registerNumber || student.usn || ""}) into ${newlyEnrolledClassIds.length} class(es).`
            );
        }

        return {
            enrolledCount: newlyEnrolledClassIds.length,
            classIds: newlyEnrolledClassIds,
        };
    } catch (err) {
        console.error(`[AutoEnroll] Error enrolling student ID ${student?.id}:`, err);
        return { enrolledCount: 0, classIds: [] };
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
            allEnrollments.map((e) => `${e.studentId}_${e.classId}`)
        );

        let totalEnrolled = 0;

        for (const student of students) {
            if (!student || !student.id) continue;

            const studentSec = normalizeSection(student.section);
            const studentSem = Number(student.semester);
            const studentDeptId = Number(student.departmentId);

            const matchingClasses = allClasses.filter((cls) => {
                const clsDeptId = Number(cls.departmentId);
                const clsSem = Number(cls.semester);
                const clsSec = normalizeSection(cls.section);

                const clsAcademicYear = String(cls.academicYear ?? "").trim();
                const studentAcademicYear = String(student.academicYear ?? "").trim();

                return (
                    clsDeptId === studentDeptId &&
                    clsSem === studentSem &&
                    clsSec === studentSec &&
                    clsAcademicYear === studentAcademicYear
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

        if (totalEnrolled > 0) {
            console.log(
                `[AutoEnroll] Bulk enrolled ${students.length} student(s) with ${totalEnrolled} new class enrollment(s).`
            );
        }

        return { totalEnrolled };
    } catch (err) {
        console.error("[AutoEnroll] Error in bulk autoEnrollStudents:", err);
        return { totalEnrolled: 0 };
    }
}

/**
 * Auto-enrolls all eligible students into a newly created class.
 *
 * @param {Object} classItem - Class record { id, departmentId, semester, section }
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ enrolledCount: number, studentIds: number[] }>}
 */
export async function autoEnrollClass(classItem, dbClient = db) {
    if (!classItem || !classItem.id) return { enrolledCount: 0, studentIds: [] };

    try {
        const clsSec = normalizeSection(classItem.section);
        const clsSem = Number(classItem.semester);
        const clsDeptId = Number(classItem.departmentId);
        const clsAcademicYear = String(classItem.academicYear ?? "").trim();

        // Fetch all students matching department and semester
        const allStudents = await dbClient.orm.public.Student.all();
        const matchingStudents = allStudents.filter((st) => {
            const stDeptId = Number(st.departmentId);
            const stSem = Number(st.semester);
            const stSec = normalizeSection(st.section);
            const stAcademicYear = String(st.academicYear ?? "").trim();

            return (
                stDeptId === clsDeptId &&
                stSem === clsSem &&
                stSec === clsSec &&
                stAcademicYear === clsAcademicYear
            );
        });

        if (matchingStudents.length === 0) {
            return { enrolledCount: 0, studentIds: [] };
        }

        // Fetch existing enrollments for this class
        const existingEnrollments = await dbClient.orm.public.Enrollment.where({
            classId: classItem.id,
        }).all();
        const enrolledStudentIds = new Set(
            existingEnrollments.map((e) => e.studentId)
        );

        const newlyEnrolledStudentIds = [];

        for (const st of matchingStudents) {
            if (!enrolledStudentIds.has(st.id)) {
                await dbClient.orm.public.Enrollment.create({
                    studentId: st.id,
                    classId: classItem.id,
                });

                enrolledStudentIds.add(st.id);
                newlyEnrolledStudentIds.push(st.id);
            }
        }

        if (newlyEnrolledStudentIds.length > 0) {
            console.log(
                `[AutoEnroll] Enrolled ${newlyEnrolledStudentIds.length} student(s) into newly created class ID ${classItem.id}.`
            );
        }

        return {
            enrolledCount: newlyEnrolledStudentIds.length,
            studentIds: newlyEnrolledStudentIds,
        };
    } catch (err) {
        console.error(`[AutoEnroll] Error enrolling class ID ${classItem?.id}:`, err);
        return { enrolledCount: 0, studentIds: [] };
    }
}

/**
 * Scans the whole database and ensures every student is enrolled into all matching classes.
 * Useful for automated healing and one-time sync.
 *
 * @param {Object} [dbClient=db]
 * @returns {Promise<{ totalEnrolled: number, missingBySemester: Record<string, number> }>}
 */
export async function syncAllEnrollments(dbClient = db) {
    try {
        const allStudents = await dbClient.orm.public.Student.all();
        const allClasses = await dbClient.orm.public.Class.all();
        const allEnrollments = await dbClient.orm.public.Enrollment.all();

        const enrollmentSet = new Set(
            allEnrollments.map((e) => `${e.studentId}_${e.classId}`)
        );

        let totalEnrolled = 0;
        const missingBySemester = {};

        for (const student of allStudents) {
            if (!student || !student.id) continue;

            const studentSec = normalizeSection(student.section);
            const studentSem = Number(student.semester);
            const studentDeptId = Number(student.departmentId);

            const matchingClasses = allClasses.filter((cls) => {
                const clsDeptId = Number(cls.departmentId);
                const clsSem = Number(cls.semester);
                const clsSec = normalizeSection(cls.section);

                const clsAcademicYear = String(cls.academicYear ?? "").trim();
                const studentAcademicYear = String(student.academicYear ?? "").trim();

                return (
                    clsDeptId === studentDeptId &&
                    clsSem === studentSem &&
                    clsSec === studentSec &&
                    clsAcademicYear === studentAcademicYear
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
                    missingBySemester[studentSem] =
                        (missingBySemester[studentSem] || 0) + 1;
                }
            }
        }

        if (totalEnrolled > 0) {
            console.log(
                `[AutoEnroll] Completed enrollment sync. Created ${totalEnrolled} missing enrollment(s).`,
                missingBySemester
            );
        } else {
            console.log("[AutoEnroll] All students are fully enrolled in matching classes.");
        }

        return { totalEnrolled, missingBySemester };
    } catch (err) {
        console.error("[AutoEnroll] Error during syncAllEnrollments:", err);
        return { totalEnrolled: 0, missingBySemester: {} };
    }
}
