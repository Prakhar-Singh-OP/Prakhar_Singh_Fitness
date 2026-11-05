import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const appSource = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const startMarker = "const DIET_FOOD_ITEMS = [";
const endMarker = "\nfunction DietPage({ userProfile, setUserProfile }) {";
const start = appSource.indexOf(startMarker);
const end = appSource.indexOf(endMarker, start);
assert.ok(start >= 0 && end > start, "Diet planner data and helpers must remain in the pure, testable block.");

const plannerSource = `${appSource.slice(start, end)}
window.__dietPlannerTestApi = { DIET_FOOD_ITEMS, buildDietMealPlan, calculateDietMealPlan, getDietMealSwapAlternatives, applyDietMealSwaps };`;
const plannerWindow = {};
vm.runInNewContext(plannerSource, { window: plannerWindow }, { filename: "index.html:diet-planner" });
const { DIET_FOOD_ITEMS, buildDietMealPlan, calculateDietMealPlan, getDietMealSwapAlternatives, applyDietMealSwaps } = plannerWindow.__dietPlannerTestApi;
const foodById = new Map(DIET_FOOD_ITEMS.map((food) => [food.id, food]));

test("meal calories and macros are derived from listed ingredient portions", () => {
  const plan = buildDietMealPlan("Omnivore (Mixed)", 50000, 1, 1, 2200, 150, "6 PM - 7 PM");
  const result = calculateDietMealPlan(plan.firstHalf, 2200, [0, 1, 2, 3, 4, 5], plan.targets.protein);

  assert.ok(Math.abs(result.totals.calories - 2200) <= 3);
  assert.ok(result.totals.protein >= plan.targets.protein - 2);
  assert.equal(result.proteinTargetMet, true);
  assert.equal(result.totals.costINR, result.meals.reduce((sum, meal) => sum + meal.costINR, 0));
  ["calories", "protein", "carbs", "fat", "fiber"].forEach((key) => {
    assert.equal(result.totals[key], result.meals.reduce((sum, meal) => sum + meal[key], 0));
  });
  result.meals.forEach((meal) => {
    const expectedProtein = Math.round(meal.ingredients.reduce(
      (total, ingredient) => total + ingredient.nutrition.protein * ingredient.servings,
      0,
    ));
    assert.equal(meal.protein, expectedProtein);
    assert.ok(meal.quantity.length > 0);
    assert.ok(meal.costINR >= 0);
  });
});

test("meal swaps stay within category and dietary preference and recalculate nutrition", () => {
  const plan = buildDietMealPlan("Vegan", 50000, 1, 1, 2200, 150, "6 PM");
  const alternatives = getDietMealSwapAlternatives("oats", "Vegan");
  assert.ok(alternatives.some((food) => food.id === "poha"));
  assert.equal(alternatives.some((food) => food.id === "eggs"), false);
  assert.equal(getDietMealSwapAlternatives("chicken", "Vegetarian").some((food) => food.id === "tofu"), true);

  const swappedMeals = applyDietMealSwaps(
    plan.firstHalf,
    { "1-first-0-0": "poha", "1-first-0-1": "eggs" },
    1,
    "first",
    "Vegan",
  );
  assert.equal(swappedMeals[0].ingredients[0].id, "poha");
  assert.equal(swappedMeals[0].ingredients[1].id, plan.firstHalf[0].ingredients[1].id);
  const calculated = calculateDietMealPlan(swappedMeals, 2200, [0, 1, 2, 3, 4, 5], plan.targets.protein);
  assert.ok(Math.abs(calculated.totals.calories - 2200) <= 3);
  assert.equal(calculated.totals.costINR, calculated.meals.reduce((sum, meal) => sum + meal.costINR, 0));
});

test("no-workout plans exclude workout meals and still use the calorie target", () => {
  const plan = buildDietMealPlan("Vegetarian", 50000, 1, 1, 1800, 130, "");
  const result = calculateDietMealPlan(plan.firstHalf, 1800, [0, 1, 4, 5], plan.targets.protein);

  assert.ok(Math.abs(result.totals.calories - 1800) <= 3);
  assert.ok(result.totals.protein >= plan.targets.protein - 2);
  assert.equal(result.meals[2].calories, 0);
  assert.equal(result.meals[3].calories, 0);
  assert.equal(result.meals[2].costINR, 0);
  assert.equal(result.meals[3].costINR, 0);
  assert.equal(result.meals.filter((meal) => meal.calories > 0).length, 4);
});

test("protein targets are balanced against calories and unreachable targets are reported", () => {
  const targets = [
    { month: 1, calories: 2200, protein: 150 },
    { month: 2, calories: 2164, protein: 150 },
    { month: 3, calories: 2131, protein: 155 },
    { month: 4, calories: 2095, protein: 160 },
    { month: 5, calories: 2059, protein: 165 },
    { month: 6, calories: 2026, protein: 170 },
  ];
  for (const dietType of ["Omnivore (Mixed)", "Vegetarian", "Vegan"]) {
    for (const budget of [1, 8000, 100000]) {
      for (const target of targets) {
        const plan = buildDietMealPlan(dietType, budget, target.month, 6, target.calories, target.protein, "6 PM");
        for (const meals of [plan.firstHalf, plan.secondHalf]) {
          const result = calculateDietMealPlan(meals, target.calories, [0, 1, 2, 3, 4, 5], target.protein);
          assert.ok(Math.abs(result.totals.calories - target.calories) <= 3, `${dietType} month ${target.month} calories`);
          assert.ok(result.totals.protein >= target.protein - 2, `${dietType} month ${target.month} protein`);
          assert.equal(result.proteinTargetMet, true);
        }
      }
    }
  }

  const plan = buildDietMealPlan("Vegan", 100000, 1, 1, 2200, 150, "6 PM");
  const unreachable = calculateDietMealPlan(plan.firstHalf, 1000, [0, 1, 2, 3, 4, 5], 300);
  assert.ok(Math.abs(unreachable.totals.calories - 1000) <= 3);
  assert.equal(unreachable.proteinTargetMet, false);
  assert.ok(unreachable.proteinShortfall > 0);
});

test("monthly budget selects lower-cost recipes and reports an unavoidable overage", () => {
  const standard = buildDietMealPlan("Omnivore (Mixed)", 100000, 1, 1, 2200, 150, "6 PM");
  const budgetPlan = buildDietMealPlan("Omnivore (Mixed)", 1, 1, 1, 2200, 150, "6 PM");

  assert.equal(standard.budget.usesBudgetAlternatives, false);
  assert.equal(budgetPlan.budget.usesBudgetAlternatives, true);
  assert.ok(budgetPlan.budget.estimatedMonthlyCost < standard.budget.estimatedMonthlyCost);
  assert.equal(budgetPlan.budget.withinBudget, false);
});

test("vegan and vegetarian plans respect their food restrictions", () => {
  const animalFoods = new Set(["eggs", "paneer", "curd", "whey", "chicken", "fish"]);
  const vegan = buildDietMealPlan("Vegan", 100000, 1, 1, 2200, 150, "6 PM");
  const vegetarian = buildDietMealPlan("Vegetarian", 100000, 1, 1, 2200, 150, "6 PM");

  assert.ok(vegan.firstHalf.every((meal) => meal.ingredients.every((item) => !animalFoods.has(item.id))));
  assert.ok(vegetarian.firstHalf.every((meal) => meal.ingredients.every((item) => !["chicken", "fish"].includes(item.id))));
});

test("days 16-30 rotate meals while retaining matching nutrition and cost calculations", () => {
  const plan = buildDietMealPlan("Vegan", 4000, 1, 1, 2200, 150, "");
  const first = calculateDietMealPlan(plan.firstHalf, 2200, [0, 1, 4, 5]);
  const second = calculateDietMealPlan(plan.secondHalf, 2200, [0, 1, 4, 5]);

  assert.notDeepEqual(
    plan.firstHalf[0].ingredients.map((item) => item.id),
    plan.secondHalf[0].ingredients.map((item) => item.id),
  );
  assert.ok(Math.abs(first.totals.calories - 2200) <= 3);
  assert.ok(Math.abs(second.totals.calories - 2200) <= 3);
  assert.ok(first.totals.costINR > 0 && second.totals.costINR > 0);
});

test("the Indian-food catalog has unique IDs and complete nutrition and dietary metadata", () => {
  assert.ok(DIET_FOOD_ITEMS.length >= 75);
  assert.equal(foodById.size, DIET_FOOD_ITEMS.length);
  assert.equal(new Set(DIET_FOOD_ITEMS.map((food) => food.name)).size, DIET_FOOD_ITEMS.length);
  DIET_FOOD_ITEMS.forEach((food) => {
    assert.ok(food.id && food.name && food.category);
    assert.ok(["grain", "protein", "fruit", "vegetable", "healthyFat"].includes(food.category));
    assert.ok(food.servingAmount > 0 && food.servingUnit);
    assert.ok(food.costINR >= 0);
    assert.equal(typeof food.vegetarian, "boolean");
    assert.equal(typeof food.vegan, "boolean");
    ["calories", "protein", "carbs", "fat", "fiber"].forEach((key) => {
      assert.ok(Number.isFinite(food.nutrition[key]) && food.nutrition[key] >= 0, `${food.id} has invalid ${key}`);
    });
  });
});

test("each 15-day menu is different and does not repeat food items within a day", () => {
  for (const dietType of ["Omnivore (Mixed)", "Vegetarian", "Vegan"]) {
    for (const month of [1, 2, 3, 4, 5, 6]) {
      for (const budget of [1, 8000, 100000]) {
        const plan = buildDietMealPlan(dietType, budget, month, 6, 2200, 150, "6 PM");
        for (const meals of [plan.firstHalf, plan.secondHalf]) {
          const usedIds = meals.flatMap((meal) => meal.ingredients.map((ingredient) => ingredient.id));
          assert.equal(new Set(usedIds).size, usedIds.length, `${dietType} month ${month} budget ${budget} repeats an ingredient`);
        }
        assert.notDeepEqual(
          plan.firstHalf.map((meal) => meal.ingredients.map((ingredient) => ingredient.id)),
          plan.secondHalf.map((meal) => meal.ingredients.map((ingredient) => ingredient.id)),
        );
      }
    }
  }
});

test("15-day rotations advance with the selected month and honor diet restrictions", () => {
  const firstMonth = buildDietMealPlan("Vegan", 100000, 1, 6, 2200, 150, "6 PM");
  const secondMonth = buildDietMealPlan("Vegan", 100000, 2, 6, 2200, 150, "6 PM");
  const thirdMonth = buildDietMealPlan("Vegan", 100000, 3, 6, 2200, 150, "6 PM");
  const veganAnimalFoods = new Set(["eggs", "paneer", "curd", "whey", "chicken", "fish", "milk", "buttermilk"]);

  assert.equal(firstMonth.rotation.firstHalf, 0);
  assert.equal(firstMonth.rotation.secondHalf, 1);
  assert.equal(secondMonth.rotation.firstHalf, 2);
  assert.equal(secondMonth.rotation.secondHalf, 3);
  assert.equal(thirdMonth.rotation.firstHalf, 4);
  assert.equal(thirdMonth.rotation.secondHalf, 5);
  assert.notDeepEqual(
    firstMonth.firstHalf.map((meal) => meal.ingredients.map((ingredient) => ingredient.id)),
    secondMonth.firstHalf.map((meal) => meal.ingredients.map((ingredient) => ingredient.id)),
  );
  [firstMonth, secondMonth, thirdMonth].forEach((plan) => {
    [plan.firstHalf, plan.secondHalf].forEach((meals) => {
      assert.ok(meals.every((meal) => meal.ingredients.every((ingredient) => !veganAnimalFoods.has(ingredient.id))));
    });
  });
});

test("every rotating lunch and dinner includes a salad without repeating foods that day", () => {
  for (const dietType of ["Omnivore (Mixed)", "Vegetarian", "Vegan"]) {
    for (const month of [1, 2, 3, 4]) {
      const plan = buildDietMealPlan(dietType, 100000, month, 6, 2200, 150, "6 PM");
      for (const meals of [plan.firstHalf, plan.secondHalf]) {
        [1, 5].forEach((mealIndex) => {
          assert.ok(
            meals[mealIndex].ingredients.some((ingredient) => /salad/i.test(foodById.get(ingredient.id).name)),
            `${dietType} month ${month} ${meals[mealIndex].name} needs a salad`,
          );
        });
        const ids = meals.flatMap((meal) => meal.ingredients.map((ingredient) => ingredient.id));
        assert.equal(
          new Set(ids).size,
          ids.length,
          `${dietType} month ${month} repeats: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(", ")}`,
        );
      }
    }
  }
});
