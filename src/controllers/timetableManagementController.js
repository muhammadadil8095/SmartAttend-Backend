import { db } from "../prisma/db.js";
import * as xlsx from "xlsx";
import PDFDocument from "pdfkit";
import { autoEnrollClass } from "../utils/enrollmentHelper.js";

// Helper: Resolve HOD department ID from authoritative JWT/session
const getHodDeptId = (req) => {
  if (req.user?.role === "HOD" || (req.user?.departmentId && req.user?.role !== "SUPER_ADMIN")) {
    return req.user.departmentId;
  }
  return null;
};

// ==============================================================================
// CONSTANTS & SCHEDULING CONFIGURATION
// ==============================================================================

export const VALID_DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

export const SCHEDULE_BLOCKS = [
  { startTime: "09:00", endTime: "10:00", label: "09:00 AM - 10:00 AM", isBreak: false, type: "theory" },
  { startTime: "10:00", endTime: "11:00", label: "10:00 AM - 11:00 AM", isBreak: false, type: "theory" },
  { startTime: "11:00", endTime: "11:15", label: "11:00 AM - 11:15 AM", isBreak: true, name: "Morning Break" },
  { startTime: "11:15", endTime: "12:15", label: "11:15 AM - 12:15 PM", isBreak: false, type: "theory" },
  { startTime: "12:15", endTime: "13:15", label: "12:15 PM - 01:15 PM", isBreak: false, type: "theory" },
  { startTime: "13:15", endTime: "14:00", label: "01:15 PM - 02:00 PM", isBreak: true, name: "Lunch Break" },
  { startTime: "14:00", endTime: "15:00", label: "02:00 PM - 03:00 PM", isBreak: false, type: "theory", monFriOnly: true },
  { startTime: "15:00", endTime: "16:00", label: "03:00 PM - 04:00 PM", isBreak: false, type: "theory", monFriOnly: true },
];

export const VALID_LAB_BLOCKS = [
  { startTime: "09:00", endTime: "11:00", label: "09:00 AM - 11:00 AM", monFriOnly: false },
  { startTime: "11:15", endTime: "13:15", label: "11:15 AM - 01:15 PM", monFriOnly: false },
  { startTime: "14:00", endTime: "16:00", label: "02:00 PM - 04:00 PM", monFriOnly: true },
];

// Helper: Normalize time to "HH:mm" (24-hr format)
export function normalizeTime(timeStr) {
  if (!timeStr) return "";
  const cleaned = String(timeStr).trim().toUpperCase();

  // Match e.g. "9:00", "09:00", "9:00 AM", "01:15 PM"
  const match = cleaned.match(/^(\d{1,2}):(\d{2})(?:\s*([AP]M))?$/i);
  if (!match) return cleaned;

  let hours = parseInt(match[1], 10);
  const minutes = match[2];
  const meridiem = match[3];

  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;

  return `${String(hours).padStart(2, "0")}:${minutes}`;
}

// Helper: Check time overlap between [startA, endA) and [startB, endB)
export function isOverlapping(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

// ==============================================================================
// IN-MEMORY PERSISTENT FALLBACK STORE
// ==============================================================================
// Ensures zero-downtime demo/local functionality when PostgreSQL is offline or unseeded

let inMemorySlots = [];

let inMemoryBatches = [
  { id: 1, name: "B1", departmentId: 1, semester: 3, section: "A", academicYear: "2025-2026", studentCount: 22 },
  { id: 2, name: "B2", departmentId: 1, semester: 3, section: "A", academicYear: "2025-2026", studentCount: 22 },
  { id: 3, name: "B3", departmentId: 1, semester: 3, section: "A", academicYear: "2025-2026", studentCount: 20 },
];

let inMemoryStudentBatches = [];

// ==============================================================================
// SCHEDULING CONSTRAINTS VALIDATOR
// ==============================================================================

export function validateSchedulingConstraints({
  slot,
  allSlotsInSchedule = [],
  existingDepartmentSlots = [],
  availableFaculty = [],
}) {
  const errors = [];

  const dayOfWeek = String(slot.dayOfWeek || "").toUpperCase();
  if (!VALID_DAYS.includes(dayOfWeek)) {
    errors.push(`Invalid day of week: "${slot.dayOfWeek}". Must be one of: ${VALID_DAYS.join(", ")}`);
  }

  const startTime = normalizeTime(slot.startTime);
  const endTime = normalizeTime(slot.endTime);

  if (!startTime || !endTime) {
    errors.push("Slot must have both startTime and endTime");
    return { valid: false, errors };
  }

  if (startTime >= endTime) {
    errors.push(`startTime (${startTime}) must be strictly earlier than endTime (${endTime})`);
  }

  // 1. HARD CONSTRAINT: Morning Break (11:00 AM - 11:15 AM)
  if (isOverlapping(startTime, endTime, "11:00", "11:15")) {
    errors.push(
      `Slot (${startTime} - ${endTime}) overlaps with Morning Break (11:00 AM - 11:15 AM). No classes or labs are permitted during breaks.`
    );
  }

  // 2. HARD CONSTRAINT: Lunch Break (01:15 PM - 02:00 PM / 13:15 - 14:00)
  if (isOverlapping(startTime, endTime, "13:15", "14:00")) {
    errors.push(
      `Slot (${startTime} - ${endTime}) overlaps with Lunch Break (01:15 PM - 02:00 PM). No classes or labs are permitted during breaks.`
    );
  }

  // 3. HARD CONSTRAINT: Saturday Schedule (09:00 AM until 01:15 PM strictly)
  if (dayOfWeek === "SATURDAY") {
    if (endTime > "13:15" || startTime >= "13:15") {
      errors.push(
        `Saturday classes must conclude by 01:15 PM. Afternoon classes (${startTime} - ${endTime}) are strictly prohibited on Saturday.`
      );
    }
  }

  // N/A / Free Period slots: only need day+time validity (breaks, Saturday).
  // Skip faculty, slot-duration, and concurrent lab checks.
  const isNASlot = Boolean(slot.isNA) || (!slot.subjectId && !slot.classId);
  if (isNASlot) {
    return { valid: errors.length === 0, errors };
  }

  // 4. Allowed slot durations
  const isLab = Boolean(slot.isLab);
  if (isLab) {
    // Must match one of valid 2-hour lab blocks
    const matchingLabBlock = VALID_LAB_BLOCKS.find(
      (b) => b.startTime === startTime && b.endTime === endTime
    );
    if (!matchingLabBlock) {
      errors.push(
        `Lab sessions must be scheduled in a continuous 2-hour block (09:00-11:00, 11:15-13:15, or 14:00-16:00). Provided: ${startTime} - ${endTime}`
      );
    } else if (matchingLabBlock.monFriOnly && dayOfWeek === "SATURDAY") {
      errors.push("Afternoon lab blocks (02:00 PM - 04:00 PM) are not allowed on Saturday.");
    }
  } else {
    // 1-hour theory slot
    const matchingTheory = SCHEDULE_BLOCKS.find(
      (b) => !b.isBreak && b.startTime === startTime && b.endTime === endTime
    );
    if (!matchingTheory) {
      errors.push(
        `Theory classes must be 1-hour slots matching official schedule blocks. Provided: ${startTime} - ${endTime}`
      );
    } else if (matchingTheory.monFriOnly && dayOfWeek === "SATURDAY") {
      errors.push("Afternoon classes (02:00 PM - 04:00 PM) are not allowed on Saturday.");
    }
  }

  // 5. Faculty Integrity: Assigned instructor must exist
  if (slot.facultyId) {
    const facultyExists = availableFaculty.some(
      (f) => String(f.id) === String(slot.facultyId)
    );
    if (!facultyExists && availableFaculty.length > 0) {
      errors.push(`Assigned Faculty ID (${slot.facultyId}) does not exist in the faculty directory.`);
    }
  }

  // 6. Concurrent Lab Limit & Overflow Logic:
  // Maximum of 2 lab sessions (2 batches) can run concurrently across a department slot.
  if (isLab) {
    // Count concurrent lab slots in the same department, day, and overlapping time
    const concurrentLabs = existingDepartmentSlots.filter((other) => {
      if (!other.isLab) return false;
      if (String(other.dayOfWeek).toUpperCase() !== dayOfWeek) return false;
      if (other.id && slot.id && other.id === slot.id) return false;
      return isOverlapping(startTime, endTime, other.startTime, other.endTime);
    });

    if (concurrentLabs.length >= 2) {
      errors.push(
        `Concurrent Lab Limit Reached: Maximum of 2 lab sessions can run concurrently in a department slot (${dayOfWeek} ${startTime}-${endTime}). Found ${concurrentLabs.length} already scheduled.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ==============================================================================
// CONTROLLER HANDLERS
// ==============================================================================

/**
 * GET /api/admin/timetable
 * Queries schedules filtered by academicYear, departmentId, semester, and section.
 * Also returns section batches, available subjects, and faculty for the editor.
 */
export const getAdminTimetable = async (req, res) => {
  try {
    let { academicYear, departmentId, semester, section } = req.query;

    const hodDeptId = getHodDeptId(req);
    let targetDepartmentId = hodDeptId ? Number(hodDeptId) : (departmentId ? Number(departmentId) : null);
    let departments = [];
    let faculty = [];
    let subjects = [];

    // Default filters if not specified
    const currentYear = academicYear || "2025-2026";
    const currentSem = semester ? Number(semester) : 3;
    const currentSec = section ? String(section).toUpperCase() : "A";
    let currentDeptId = targetDepartmentId || 1;

    let slots = [];
    let batches = [];

    try {
      const [dbSlots, dbBatches, classes, dbDepartments, dbSubjects, dbFaculty, users] = await Promise.all([
        db.orm.public.TimetableSlot.all(),
        db.orm.public.LabBatch.all(),
        db.orm.public.Class.all(),
        db.orm.public.Department.all(),
        db.orm.public.Subject.all(),
        db.orm.public.Faculty.all(),
        db.orm.public.User.all(),
      ]);
      departments = dbDepartments;
      currentDeptId = targetDepartmentId || departments[0]?.id || 1;
      subjects = dbSubjects;
      faculty = dbFaculty.map((member) => {
        const user = users.find((candidate) => candidate.id === member.userId);
        return { ...member, name: user?.name || "", email: user?.email || "" };
      });

      if (dbSlots && dbSlots.length > 0) {
        slots = dbSlots
          .map((slot) => {
            // A free/N-A editor cell has no Class relation. TimetableSlot.classId
            // is required, so free cells intentionally have no database record.
            if (!slot.classId) return null;

            const cls = classes.find((c) => c.id === slot.classId);
            if (!cls) return null;
            if (
              cls.academicYear === currentYear &&
              cls.departmentId === currentDeptId &&
              cls.semester === currentSem &&
              cls.section === currentSec
            ) {
              const subj = subjects.find((s) => s.id === cls.subjectId);
              const fac = faculty.find((f) => f.id === cls.facultyId);
              const batch = dbBatches.find((b) => b.id === slot.batchId);

              return {
                id: slot.id,
                classId: slot.classId,
                academicYear: cls.academicYear,
                departmentId: cls.departmentId,
                semester: cls.semester,
                section: cls.section,
                dayOfWeek: slot.dayOfWeek,
                startTime: slot.startTime,
                endTime: slot.endTime,
                isLab: slot.isLab,
                isNA: false,
                subjectId: cls.subjectId,
                subjectCode: subj?.code || "",
                subjectName: subj?.name || "",
                facultyId: cls.facultyId,
                facultyName: fac?.name || "",
                batchId: slot.batchId,
                batchName: batch?.name || null,
                room: "LH-101",
              };
            }
            return null;
          })
          .filter(Boolean);
      }

      if (dbBatches && dbBatches.length > 0) {
        batches = dbBatches.filter(
          (b) =>
            b.departmentId === currentDeptId &&
            b.semester === currentSem &&
            b.section === currentSec &&
            b.academicYear === currentYear
        );
      }
    } catch (e) {
      // Use in-memory slots if DB table not yet seeded/migrated
    }

    if (slots.length === 0) {
      slots = inMemorySlots.filter(
        (s) =>
          (s.academicYear === currentYear || !currentYear) &&
          (s.departmentId === currentDeptId || !currentDeptId) &&
          (s.semester === currentSem || !currentSem) &&
          (s.section === currentSec || !currentSec)
      );
    }

    if (batches.length === 0) {
      batches = inMemoryBatches.filter(
        (b) =>
          b.departmentId === currentDeptId &&
          b.semester === currentSem &&
          b.section === currentSec
      );
    }

    // Check for 3-batch overflow indicators on lab slots:
    // If a section has 3 batches (B1, B2, B3) and exactly 2 are assigned to a lab block,
    // compute which batch gets an automatic free period
    const sectionBatchNames = batches.map((b) => b.name);
    const enrichedSlots = slots.map((s) => {
      if (s.isLab && sectionBatchNames.length === 3) {
        const concurrent = slots.filter(
          (other) =>
            other.isLab &&
            other.dayOfWeek === s.dayOfWeek &&
            other.startTime === s.startTime &&
            other.endTime === s.endTime
        );
        const assignedBatches = concurrent.map((c) => c.batchName).filter(Boolean);
        if (assignedBatches.length === 2) {
          const freeBatch = sectionBatchNames.find((b) => !assignedBatches.includes(b));
          return {
            ...s,
            overflowFreeBatch: freeBatch || null,
          };
        }
      }
      return s;
    });

    const responsePayload = {
      academicYear: currentYear,
      departmentId: currentDeptId,
      semester: currentSem,
      section: currentSec,
      slots: enrichedSlots,
      batches,
      subjects: subjects.filter((s) => Number(s.departmentId) === Number(currentDeptId)),
      faculty: faculty.filter((f) => Number(f.departmentId) === Number(currentDeptId)),
      departments,
      scheduleBlocks: SCHEDULE_BLOCKS,
      labBlocks: VALID_LAB_BLOCKS,
    };

    return res.status(200).json({
      success: true,
      data: responsePayload,
      ...responsePayload,
    });
  } catch (error) {
    console.error("Error fetching timetable:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch timetable",
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/timetable/grid
 * Bulk creates/updates grid slots sent from the web admin interface.
 */
export const saveAdminTimetableGrid = async (req, res) => {
  try {
    const { academicYear, departmentId, semester, section, slots } = req.body;

    if (!academicYear || !departmentId || !semester || !section || !Array.isArray(slots)) {
      return res.status(400).json({
        success: false,
        message: "academicYear, departmentId, semester, section, and slots array are required",
      });
    }

    const hodDeptId = getHodDeptId(req);
    if (hodDeptId && Number(departmentId) !== Number(hodDeptId)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot modify timetables outside your authorized department.",
      });
    }

    const deptId = Number(departmentId);
    const sem = Number(semester);
    const sec = String(section).toUpperCase();

    // Fetch existing faculty to validate integrity
    let availableFaculty = [];
    try {
      const rawFaculty = await db.orm.public.Faculty.all();
      const users = await db.orm.public.User.all();
      availableFaculty = rawFaculty.map((f) => {
        const u = users.find((user) => user.id === f.userId);
        return { id: f.id, name: u?.name || "", departmentId: f.departmentId };
      });
    } catch {
      availableFaculty = [
        { id: 1, name: "Dr. Rajesh Sharma", departmentId: deptId },
        { id: 2, name: "Prof. Priya Nair", departmentId: deptId },
        { id: 3, name: "Dr. Anita Desai", departmentId: deptId },
        { id: 4, name: "Prof. Suresh Verma", departmentId: deptId },
      ];
    }

    // Run constraint validations on all slots
    const allValidationErrors = [];
    const normalizedSlots = [];

    // Track department slots for concurrent lab checks
    const activeDeptSlots = inMemorySlots.filter((s) => s.departmentId === deptId);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (!slot.startTime || !slot.endTime || !slot.dayOfWeek) continue;

      const normSlot = {
        ...slot,
        startTime: normalizeTime(slot.startTime),
        endTime: normalizeTime(slot.endTime),
        dayOfWeek: String(slot.dayOfWeek).toUpperCase(),
        departmentId: deptId,
        semester: sem,
        section: sec,
        academicYear,
      };

      const validation = validateSchedulingConstraints({
        slot: normSlot,
        allSlotsInSchedule: normalizedSlots,
        existingDepartmentSlots: activeDeptSlots,
        availableFaculty,
      });

      if (!validation.valid) {
        allValidationErrors.push({
          slotIndex: i,
          dayOfWeek: normSlot.dayOfWeek,
          time: `${normSlot.startTime}-${normSlot.endTime}`,
          errors: validation.errors,
        });
      }

      normalizedSlots.push(normSlot);
    }

    if (allValidationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Validation failed for timetable slots",
        validationErrors: allValidationErrors,
      });
    }

    // Update in-memory persistent store
    inMemorySlots = inMemorySlots.filter(
      (s) =>
        !(
          s.academicYear === academicYear &&
          s.departmentId === deptId &&
          s.semester === sem &&
          s.section === sec
        )
    );

    let nextId = inMemorySlots.length > 0 ? Math.max(...inMemorySlots.map((s) => s.id || 0)) + 1 : 1;
    const savedSlots = normalizedSlots.map((s) => {
      const saved = {
        ...s,
        id: s.id || nextId++,
      };
      inMemorySlots.push(saved);
      return saved;
    });

    // Try saving to database if available. Replace every persisted slot for this
    // exact section so removing a cell in the editor also removes it on reload.
    try {
      const allClasses = await db.orm.public.Class.all();
      const scopedClassIds = new Set(
        allClasses
          .filter(
            (classItem) =>
              classItem.departmentId === deptId &&
              classItem.semester === sem &&
              classItem.section === sec &&
              classItem.academicYear === academicYear
          )
          .map((classItem) => classItem.id)
      );
      const existingDbSlots = await db.orm.public.TimetableSlot.all();
      for (const existingSlot of existingDbSlots) {
        if (scopedClassIds.has(existingSlot.classId)) {
          await db.orm.public.TimetableSlot.where({ id: existingSlot.id }).delete();
        }
      }

      for (const s of normalizedSlots) {
        const isNASlot = !s.subjectId || !s.facultyId || s.isNA;

        if (isNASlot) {
          // classId is non-nullable. An omitted record restores as a free cell
          // and avoids the invalid null foreign-key write.
          continue;
        } else {
          // Regular class slot — find or create Class, then create TimetableSlot
          const matchingClasses = await db.orm.public.Class.where({
            subjectId: Number(s.subjectId),
            facultyId: Number(s.facultyId),
            departmentId: deptId,
            semester: sem,
            section: sec,
            academicYear: academicYear,
          }).all();
          let classItem = matchingClasses[0] || null;

          if (!classItem) {
            classItem = await db.orm.public.Class.create({
              subjectId: Number(s.subjectId),
              facultyId: Number(s.facultyId),
              departmentId: deptId,
              semester: sem,
              section: sec,
              academicYear: academicYear,
            });

            // Auto-enroll all matching students into this new class
            await autoEnrollClass(classItem);
          }

          if (classItem && classItem.id) {
            await db.orm.public.TimetableSlot.create({
              classId: classItem.id,
              dayOfWeek: s.dayOfWeek,
              startTime: s.startTime,
              endTime: s.endTime,
              isLab: Boolean(s.isLab),
              batchId: s.batchId ? Number(s.batchId) : null,
            });
          }
        }
      }
    } catch (dbErr) {
      // Database unavailable or not migrated; fallback store holds state reliably
      console.error("Failed to persist timetable grid to database:", dbErr);
    }

    // ── B3 Overflow Auto-Enforcement ──────────────────────────────────────────
    // If a section has 3 batches and only 2 lab sessions are assigned in a
    // concurrent window, the 3rd batch automatically gets an N/A Free Period.
    const sectionBatches = inMemoryBatches.filter(
      (b) => b.departmentId === deptId && b.semester === sem && b.section === sec
    );

    if (sectionBatches.length === 3) {
      const labSlots = savedSlots.filter((s) => s.isLab && s.batchId);

      // Group lab slots by day + time window
      const labWindows = {};
      for (const ls of labSlots) {
        const key = `${ls.dayOfWeek}_${ls.startTime}_${ls.endTime}`;
        if (!labWindows[key]) labWindows[key] = [];
        labWindows[key].push(ls);
      }

      for (const [key, windowSlots] of Object.entries(labWindows)) {
        if (windowSlots.length === 2) {
          const assignedBatchIds = windowSlots.map((ws) => ws.batchId);
          const freeBatch = sectionBatches.find((b) => !assignedBatchIds.includes(b.id));

          if (freeBatch) {
            const [dayOfWeek, startTime, endTime] = key.split("_");

            // Check if N/A already exists for this batch in this window
            const alreadyExists = savedSlots.some(
              (s) =>
                s.isNA &&
                s.batchId === freeBatch.id &&
                s.dayOfWeek === dayOfWeek &&
                s.startTime === startTime &&
                s.endTime === endTime
            );

            if (!alreadyExists) {
              const naSlot = {
                id: nextId++,
                classId: null,
                academicYear,
                departmentId: deptId,
                semester: sem,
                section: sec,
                dayOfWeek,
                startTime,
                endTime,
                isLab: false,
                isNA: true,
                subjectId: null,
                subjectCode: "N/A",
                subjectName: "Free Period",
                facultyId: null,
                facultyName: "",
                batchId: freeBatch.id,
                batchName: freeBatch.name,
                room: null,
              };

              inMemorySlots.push(naSlot);
              savedSlots.push(naSlot);

              console.log(
                `[B3 Overflow] Auto-created N/A Free Period for batch ${freeBatch.name} on ${dayOfWeek} ${startTime}-${endTime}`
              );
            }
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: `Successfully saved ${savedSlots.length} timetable slots for ${sec} Section`,
      data: savedSlots,
    });
  } catch (error) {
    console.error("Error saving timetable grid:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save timetable grid",
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/timetable/import
 * Parses uploaded Excel/CSV file using multer and populates TimetableSlot.
 */
export const importAdminTimetable = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: "Please upload an Excel (.xlsx, .xls) or CSV file",
      });
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return res.status(400).json({
        success: false,
        message: "Spreadsheet contains no readable sheets",
      });
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows || rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "The uploaded file contains no data rows",
      });
    }

    const importedSlots = [];
    const validationErrors = [];

    // Parse each row
    rows.forEach((row, idx) => {
      // Normalize column keys
      const rowData = {};
      Object.keys(row).forEach((key) => {
        const cleanKey = key.trim().toLowerCase().replace(/[\s_-]+/g, "");
        rowData[cleanKey] = String(row[key]).trim();
      });

      const dayOfWeek = (
        rowData.day ||
        rowData.dayofweek ||
        rowData.weekday ||
        "MONDAY"
      ).toUpperCase();

      const startTime = normalizeTime(rowData.starttime || rowData.start || rowData.from);
      const endTime = normalizeTime(rowData.endtime || rowData.end || rowData.to);
      const isLab = /lab|true|yes|1/i.test(rowData.islab || rowData.type || "");
      const subjectCode = rowData.subjectcode || rowData.subject || rowData.code || "";
      const subjectName = rowData.subjectname || rowData.subject || "Subject";
      const facultyName = rowData.faculty || rowData.facultyname || rowData.instructor || "Faculty";
      const batchName = rowData.batch || rowData.batchname || rowData.labbatch || null;
      const room = rowData.room || rowData.classroom || "LH-101";
      const academicYear = rowData.academicyear || rowData.year || "2025-2026";
      const semester = parseInt(rowData.semester || rowData.sem || "3", 10);
      const section = (rowData.section || rowData.sec || "A").toUpperCase();
      const hodDeptId = getHodDeptId(req);
      const departmentId = hodDeptId ? Number(hodDeptId) : parseInt(rowData.departmentid || "1", 10);

      const slot = {
        id: inMemorySlots.length + importedSlots.length + 1,
        dayOfWeek,
        startTime,
        endTime,
        isLab,
        subjectCode,
        subjectName,
        facultyName,
        batchName,
        room,
        academicYear,
        semester,
        section,
        departmentId,
      };

      const validation = validateSchedulingConstraints({
        slot,
        allSlotsInSchedule: importedSlots,
        existingDepartmentSlots: inMemorySlots,
      });

      if (!validation.valid) {
        validationErrors.push({
          row: idx + 2, // 1-indexed plus header
          errors: validation.errors,
        });
      } else {
        importedSlots.push(slot);
      }
    });

    if (importedSlots.length === 0 && validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Failed to import timetable. All rows violated scheduling constraints.",
        validationErrors,
      });
    }

    // Append imported slots to memory store
    importedSlots.forEach((slot) => inMemorySlots.push(slot));

    // Persist imported slots to database (mirrors grid-save logic)
    let dbSavedCount = 0;
    try {
      for (const s of importedSlots) {
        const isNASlot = !s.subjectCode || s.subjectCode === "N/A" || s.isNA;

        if (isNASlot) {
          // Free periods have no Class row; classId is required by the schema.
          continue;
        } else if (s.subjectCode && s.departmentId) {
          // Try to find subject by code
          let subject = null;
          let facultyItem = null;
          try {
            const allSubjects = await db.orm.public.Subject.all();
            subject = allSubjects.find(
              (sub) => sub.code === s.subjectCode && sub.departmentId === s.departmentId
            );

            if (s.facultyName) {
              const allFaculty = await db.orm.public.Faculty.all();
              const allUsers = await db.orm.public.User.all();
              facultyItem = allFaculty.find((f) => {
                const u = allUsers.find((user) => user.id === f.userId);
                return u && u.name.toLowerCase().includes(s.facultyName.toLowerCase());
              });
            }
          } catch {
            // DB query failed, skip DB persistence for this slot
            continue;
          }

          if (subject && facultyItem) {
            const matchingClasses = await db.orm.public.Class.where({
              subjectId: subject.id,
              facultyId: facultyItem.id,
              departmentId: s.departmentId,
              semester: s.semester,
              section: s.section,
              academicYear: s.academicYear,
            }).all();
            let classItem = matchingClasses[0] || null;

            if (!classItem) {
              classItem = await db.orm.public.Class.create({
                subjectId: subject.id,
                facultyId: facultyItem.id,
                departmentId: s.departmentId,
                semester: s.semester,
                section: s.section,
                academicYear: s.academicYear,
              });

              // Auto-enroll all matching students into this new class
              await autoEnrollClass(classItem);
            }

            if (classItem && classItem.id) {
              await db.orm.public.TimetableSlot.create({
                classId: classItem.id,
                dayOfWeek: s.dayOfWeek,
                startTime: s.startTime,
                endTime: s.endTime,
                isLab: Boolean(s.isLab),
                batchId: s.batchId ? Number(s.batchId) : null,
              });
              dbSavedCount++;
            }
          }
        }
      }
    } catch (dbErr) {
      console.error("Import DB persistence error (non-fatal):", dbErr.message);
      // Database unavailable or not migrated; in-memory store holds state
    }

    return res.status(200).json({
      success: true,
      message: `Successfully imported ${importedSlots.length} timetable slot(s).${dbSavedCount > 0 ? ` ${dbSavedCount} persisted to database.` : ""}`,
      importedCount: importedSlots.length,
      dbSavedCount,
      skippedCount: validationErrors.length,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      data: importedSlots,
    });
  } catch (error) {
    console.error("Error importing timetable:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to process uploaded timetable file",
      error: error.message,
    });
  }
};

/**
 * GET /api/admin/timetable/export
 * Generates and streams downloadable Excel (.xlsx) or PDF files of the generated timetable.
 */
export const exportAdminTimetable = async (req, res) => {
  try {
    const { academicYear = "2025-2026", departmentId = "1", semester = "3", section = "A", format = "xlsx" } = req.query;

    const hodDeptId = getHodDeptId(req);
    if (hodDeptId && Number(departmentId) !== Number(hodDeptId)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot export timetables outside your authorized department.",
      });
    }

    const deptId = hodDeptId ? Number(hodDeptId) : Number(departmentId);
    const sem = Number(semester);
    const sec = String(section).toUpperCase();

    const slots = inMemorySlots.filter(
      (s) =>
        s.academicYear === academicYear &&
        s.departmentId === deptId &&
        s.semester === sem &&
        s.section === sec
    );

    const timestamp = new Date().toISOString().slice(0, 10);
    const fileNameBase = `Timetable_${academicYear}_Sem${sem}_Sec${sec}_${timestamp}`;

    // --------------------------------------------------------------------------
    // 1. PDF EXPORT
    // --------------------------------------------------------------------------
    if (String(format).toLowerCase() === "pdf") {
      const doc = new PDFDocument({
        layout: "landscape",
        size: "A4",
        margin: 30,
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fileNameBase}.pdf"`);

      doc.pipe(res);

      // Title & College Header
      doc.fontSize(16).font("Helvetica-Bold").text("SMARTATTEND ACADEMIC CONSOLE", { align: "center" });
      doc.fontSize(12).font("Helvetica-Bold").text("Department of Computer Science & Engineering", { align: "center" });
      doc.moveDown(0.2);
      doc.fontSize(10).font("Helvetica").text(
        `Academic Year: ${academicYear}   |   Semester: ${sem}   |   Section: ${sec}   |   Generated: ${new Date().toLocaleDateString()}`,
        { align: "center" }
      );
      doc.moveDown(1);

      // Table Metrics
      const startX = 30;
      let startY = 110;
      const colWidthTime = 95;
      const colWidthDay = 115;
      const rowHeight = 44;

      const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

      // Draw Table Header
      doc.rect(startX, startY, colWidthTime + colWidthDay * days.length, 24).fill("#1e293b");
      doc.fillColor("#ffffff").fontSize(9).font("Helvetica-Bold");
      doc.text("TIME / DAY", startX + 5, startY + 7);

      days.forEach((day, i) => {
        doc.text(day, startX + colWidthTime + i * colWidthDay + 10, startY + 7);
      });

      startY += 24;

      // Draw Rows for Time Blocks
      SCHEDULE_BLOCKS.forEach((block) => {
        // Background
        if (block.isBreak) {
          doc.rect(startX, startY, colWidthTime + colWidthDay * days.length, 22).fill("#f1f5f9");
          doc.fillColor("#475569").fontSize(9).font("Helvetica-Bold");
          doc.text(`${block.label} - ${block.name}`, startX + 15, startY + 6);
          startY += 22;
          return;
        }

        doc.rect(startX, startY, colWidthTime + colWidthDay * days.length, rowHeight).stroke("#cbd5e1");
        doc.fillColor("#0f172a").fontSize(8).font("Helvetica-Bold");
        doc.text(block.label, startX + 5, startY + 6, { width: colWidthTime - 8 });

        // Day Columns
        days.forEach((day, dIdx) => {
          const cellX = startX + colWidthTime + dIdx * colWidthDay;

          if (day === "SATURDAY" && block.monFriOnly) {
            doc.fillColor("#94a3b8").fontSize(7).font("Helvetica-Oblique");
            doc.text("No Class", cellX + 10, startY + 14);
            return;
          }

          // Find slot matching day and time
          const matchingSlot = slots.find(
            (s) =>
              s.dayOfWeek === day &&
              (s.startTime === block.startTime ||
                (s.isLab && isOverlapping(s.startTime, s.endTime, block.startTime, block.endTime)))
          );

          if (matchingSlot) {
            doc.fillColor(matchingSlot.isLab ? "#1d4ed8" : "#0f172a").fontSize(8).font("Helvetica-Bold");
            const title = matchingSlot.isLab
              ? `[LAB] ${matchingSlot.subjectCode || "Lab"}${matchingSlot.batchName ? ` (${matchingSlot.batchName})` : ""}`
              : matchingSlot.subjectCode;
            doc.text(title, cellX + 5, startY + 6, { width: colWidthDay - 10 });

            doc.fillColor("#475569").fontSize(7).font("Helvetica");
            doc.text(matchingSlot.facultyName || "Faculty", cellX + 5, startY + 18, { width: colWidthDay - 10 });
            doc.fillColor("#64748b").fontSize(6.5).font("Helvetica");
            doc.text(matchingSlot.room || "Room", cellX + 5, startY + 29);
          } else {
            doc.fillColor("#cbd5e1").fontSize(7).font("Helvetica");
            doc.text("-", cellX + 30, startY + 15);
          }
        });

        startY += rowHeight;
      });

      // Footer note
      doc.moveDown(2);
      doc.fontSize(7.5).font("Helvetica-Oblique").fillColor("#64748b").text(
        "Note: SmartAttend scheduling limits concurrent lab sessions to 2 per department. If Section A has 3 batches (B1, B2, B3), the 3rd batch receives an automatic free period to be scheduled in an alternate open slot.",
        startX,
        doc.page.height - 40
      );

      doc.end();
      return;
    }

    // --------------------------------------------------------------------------
    // 2. EXCEL EXPORT (DEFAULT)
    // --------------------------------------------------------------------------
    const days = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    const headerRow = ["Time Slot", ...days];

    const aoa = [
      ["SMARTATTEND ACADEMIC TIMETABLE"],
      [`Academic Year: ${academicYear} | Semester: ${sem} | Section: ${sec}`],
      [],
      headerRow,
    ];

    SCHEDULE_BLOCKS.forEach((block) => {
      if (block.isBreak) {
        aoa.push([block.label, `*** ${block.name.toUpperCase()} ***`, "", "", "", "", ""]);
        return;
      }

      const row = [block.label];

      days.forEach((day) => {
        if (day === "SATURDAY" && block.monFriOnly) {
          row.push("No Class (Saturday Afternoon)");
          return;
        }

        const match = slots.find(
          (s) =>
            s.dayOfWeek === day &&
            (s.startTime === block.startTime ||
              (s.isLab && isOverlapping(s.startTime, s.endTime, block.startTime, block.endTime)))
        );

        if (match) {
          const typeTag = match.isLab ? `[LAB - ${match.batchName || "All"}] ` : "";
          row.push(`${typeTag}${match.subjectCode}: ${match.subjectName} (${match.facultyName || "TBD"}, ${match.room || "LH"})`);
        } else {
          row.push("-");
        }
      });

      aoa.push(row);
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(aoa);

    // Set column widths
    ws["!cols"] = [
      { wch: 24 }, // Time
      { wch: 32 }, // Monday
      { wch: 32 }, // Tuesday
      { wch: 32 }, // Wednesday
      { wch: 32 }, // Thursday
      { wch: 32 }, // Friday
      { wch: 32 }, // Saturday
    ];

    xlsx.utils.book_append_sheet(wb, ws, `Sem${sem}_Sec${sec}`);

    const buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileNameBase}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    console.error("Export timetable error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to export timetable",
      error: error.message,
    });
  }
};

/**
 * GET /api/admin/batches
 * Returns lab batches for the specified department, semester, and section.
 */
export const getAdminBatches = async (req, res) => {
  try {
    const { departmentId, semester, section, academicYear } = req.query;

    const hodDeptId = getHodDeptId(req);
    const deptId = hodDeptId ? Number(hodDeptId) : (departmentId ? Number(departmentId) : 1);
    const sem = semester ? Number(semester) : 3;
    const sec = section ? String(section).toUpperCase() : "A";
    const year = academicYear || "2025-2026";

    let batches = inMemoryBatches.filter(
      (b) => b.departmentId === deptId && b.semester === sem && b.section === sec
    );

    // If no batches exist for this section, initialize standard B1, B2, B3
    if (batches.length === 0) {
      const b1 = { id: 101, name: "B1", departmentId: deptId, semester: sem, section: sec, academicYear: year, studentCount: 22 };
      const b2 = { id: 102, name: "B2", departmentId: deptId, semester: sem, section: sec, academicYear: year, studentCount: 22 };
      const b3 = { id: 103, name: "B3", departmentId: deptId, semester: sem, section: sec, academicYear: year, studentCount: 20 };
      batches = [b1, b2, b3];
      inMemoryBatches.push(b1, b2, b3);
    }

    return res.status(200).json({
      success: true,
      data: batches,
    });
  } catch (error) {
    console.error("Get batches error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch lab batches",
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/batches
 * Creates or splits section students into batches (B1, B2, B3).
 */
export const createOrSplitBatches = async (req, res) => {
  try {
    const { departmentId, semester, section, academicYear, batchNames = ["B1", "B2", "B3"], autoSplitStudents = true } = req.body;

    const hodDeptId = getHodDeptId(req);
    if (hodDeptId && Number(departmentId) !== Number(hodDeptId)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You cannot create or split batches outside your authorized department.",
      });
    }

    const deptId = hodDeptId ? Number(hodDeptId) : Number(departmentId);
    const sem = Number(semester);
    const sec = String(section).toUpperCase();
    const year = academicYear || "2025-2026";

    // Remove existing batches for this section in memory
    inMemoryBatches = inMemoryBatches.filter(
      (b) => !(b.departmentId === deptId && b.semester === sem && b.section === sec)
    );

    let nextId = inMemoryBatches.length > 0 ? Math.max(...inMemoryBatches.map((b) => b.id || 0)) + 1 : 1;

    const newBatches = batchNames.map((name) => {
      const b = {
        id: nextId++,
        name: name.trim().toUpperCase(),
        departmentId: deptId,
        semester: sem,
        section: sec,
        academicYear: year,
        studentCount: 20,
      };
      inMemoryBatches.push(b);
      return b;
    });

    return res.status(201).json({
      success: true,
      message: `Created ${newBatches.length} lab batches (${batchNames.join(", ")}) for Section ${sec}`,
      data: newBatches,
    });
  } catch (error) {
    console.error("Create batches error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create lab batches",
      error: error.message,
    });
  }
};

/**
 * POST /api/admin/batches/assign
 * Assigns students to a specific LabBatch.
 */
export const assignStudentBatch = async (req, res) => {
  try {
    const { studentId, batchId } = req.body;

    if (!studentId || !batchId) {
      return res.status(400).json({
        success: false,
        message: "studentId and batchId are required",
      });
    }

    const hodDeptId = getHodDeptId(req);
    if (hodDeptId) {
      try {
        const students = await db.orm.public.Student.where({ id: Number(studentId) }).all();
        if (students && students.length > 0 && Number(students[0].departmentId) !== Number(hodDeptId)) {
          return res.status(403).json({
            success: false,
            message: "Forbidden: You cannot assign students outside your authorized department.",
          });
        }
      } catch {}
    }

    // In-memory assignment
    inMemoryStudentBatches = inMemoryStudentBatches.filter((sb) => sb.studentId !== Number(studentId));
    inMemoryStudentBatches.push({
      studentId: Number(studentId),
      batchId: Number(batchId),
    });

    return res.status(200).json({
      success: true,
      message: "Student assigned to lab batch successfully",
    });
  } catch (error) {
    console.error("Assign student batch error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to assign student to lab batch",
      error: error.message,
    });
  }
};