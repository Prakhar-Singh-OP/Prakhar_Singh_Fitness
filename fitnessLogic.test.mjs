import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const appSource = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const helperStart = appSource.indexOf("function parseTimeToken(");
const helperEnd = appSource.indexOf("\nfunction getTimelineMonths(", helperStart);
const databaseStart = appSource.indexOf("const exerciseDatabase = {");
const databaseEnd = appSource.indexOf("\nconst initialProfile = {", databaseStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Fitness calculation helpers must remain independently testable.");
assert.ok(databaseStart >= 0 && databaseEnd > databaseStart, "Workout exercise data must remain independently testable.");

const testWindow = {};
vm.runInNewContext(
  `${appSource.slice(helperStart, helperEnd)}\n${appSource.slice(databaseStart, databaseEnd)}\nwindow.__fitnessLogic = { parseWorkoutTimes, getScheduledMealTimes, getWorkoutPrescription, getCurrentWorkoutDay, exerciseDatabase };`,
  { window: testWindow },
  { filename: "index.html:fitness-logic" },
);
const { parseWorkoutTimes, getScheduledMealTimes, getWorkoutPrescription, getCurrentWorkoutDay, exerciseDatabase } = testWindow.__fitnessLogic;

test("meal schedules are chronological and place an afternoon pre-workout meal ahead of training", () => {
  const schedule = getScheduledMealTimes("3 PM");

  assert.deepEqual(Array.from(schedule, ([hour]) => hour), [7, 12, 13.5, 14.5, 16.5, 20]);
  assert.deepEqual(Array.from(schedule, ([, mealIndex]) => mealIndex), [0, 1, 4, 2, 3, 5]);
  assert.ok(schedule[2][0] <= parseWorkoutTimes("3 PM").startHour - 1);
});

test("morning, midday, evening, late, and no-workout meal schedules remain ordered", () => {
  for (const workoutTime of ["4 AM", "6 AM", "12 PM", "6 PM", "8 PM", ""]) {
    const hours = Array.from(getScheduledMealTimes(workoutTime), ([hour]) => hour);
    assert.deepEqual(hours, [...hours].sort((left, right) => left - right), workoutTime || "no workout");
    assert.equal(new Set(hours).size, hours.length, `${workoutTime || "no workout"} has overlapping meals`);
  }
  const earlyPreWorkout = getScheduledMealTimes("4 AM").find(([, mealIndex]) => mealIndex === 2);
  assert.ok(earlyPreWorkout[0] < parseWorkoutTimes("4 AM").startHour);
});

test("workout times that wrap past midnight are rejected", () => {
  assert.equal(parseWorkoutTimes("11 PM"), null);
  assert.equal(parseWorkoutTimes("11:30 PM"), null);
  assert.equal(parseWorkoutTimes("10:15 PM").startHour, 22.25);
  assert.equal(parseWorkoutTimes("10:30 PM"), null);
  assert.equal(parseWorkoutTimes("10 PM").endHour, 23);
});

test("each workout level provides cardio choices and a level-specific prescription", () => {
  const expectedRest = { Beginner: 60, Intermediate: 90, Advanced: 120 };

  Object.entries(exerciseDatabase).forEach(([level, plans]) => {
    ["home", "gym"].forEach((location) => {
      const cardio = plans[location].find((group) => group.type === "cardio");
      assert.ok(cardio && cardio.exercises.length >= 2, `${level} ${location} requires cardio options`);
    });
    const prescription = getWorkoutPrescription(level);
    assert.equal(prescription.sets, 3);
    assert.equal(prescription.restSeconds, expectedRest[level]);
    assert.ok(prescription.cardioMinutes);
  });
});

test("the dashboard and workout page share the current day in each weekly routine", () => {
  const tuesday = getCurrentWorkoutDay("Intermediate", new Date(2026, 10, 3));
  assert.equal(tuesday.dayName, "Tuesday");
  assert.equal(tuesday.title, "Pull + Biceps");
  assert.deepEqual(Array.from(tuesday.targets), ["Back", "Biceps", "Shoulders"]);
  assert.equal(tuesday.isRestDay, false);

  const sunday = getCurrentWorkoutDay("Beginner", new Date(2026, 10, 8));
  assert.equal(sunday.title, "Rest and Recovery Time");
  assert.equal(sunday.isRestDay, true);
});
