(function () {
  function buildBasePlan(dietType, calorieTarget, proteinTarget, vegetarianMode) {
    const calories = Number(calorieTarget) || 2200;
    const protein = Number(proteinTarget) || 150;
    const base = vegetarianMode ? [
      { timing: '7:00 AM — Breakfast', meal: 'Oats + Paneer + Fruit', quantity: '80g oats + 150g paneer + 1 banana', calories: Math.round(calories * 0.28), protein: Math.max(22, Math.round(protein * 0.28)), carbs: 56, fat: 18, fiber: 9 },
      { timing: '1:00 PM — Lunch', meal: 'Tofu + Rice + Veg', quantity: '150g tofu + 200g rice + 200g veg', calories: Math.round(calories * 0.31), protein: Math.max(28, Math.round(protein * 0.31)), carbs: 68, fat: 17, fiber: 10 },
      { timing: '4:30 PM — Pre Workout', meal: 'Yogurt + Fruit', quantity: '200g curd + 1 banana', calories: Math.round(calories * 0.12), protein: Math.max(10, Math.round(protein * 0.10)), carbs: 32, fat: 4, fiber: 4 },
      { timing: '6:30 PM — Post Workout', meal: 'Soy Shake + Fruit', quantity: '1 soy shake + 1 fruit', calories: Math.round(calories * 0.12), protein: Math.max(18, Math.round(protein * 0.12)), carbs: 28, fat: 4, fiber: 3 },
      { timing: '8:30 PM — Snack', meal: 'Paneer / Soya Chunks', quantity: '150g paneer or 50g soya chunks', calories: Math.round(calories * 0.10), protein: Math.max(12, Math.round(protein * 0.10)), carbs: 18, fat: 8, fiber: 2 },
      { timing: '9:30 PM — Dinner', meal: 'Dal + Rice + Veg', quantity: '150g dal + 150g rice + 200g veg', calories: Math.round(calories * 0.28), protein: Math.max(26, Math.round(protein * 0.28)), carbs: 50, fat: 14, fiber: 11 },
    ] : [
      { timing: '7:00 AM — Breakfast', meal: 'Oats + Eggs + Fruit', quantity: '80g oats + 3 eggs + 1 banana', calories: Math.round(calories * 0.28), protein: Math.max(20, Math.round(protein * 0.26)), carbs: 55, fat: 14, fiber: 9 },
      { timing: '1:00 PM — Lunch', meal: 'Chicken + Rice + Veg', quantity: '150g chicken + 200g rice + 200g veg', calories: Math.round(calories * 0.31), protein: Math.max(28, Math.round(protein * 0.30)), carbs: 70, fat: 15, fiber: 9 },
      { timing: '4:30 PM — Pre Workout', meal: 'Yogurt + Fruit', quantity: '200g curd + 1 banana', calories: Math.round(calories * 0.12), protein: Math.max(10, Math.round(protein * 0.10)), carbs: 32, fat: 3, fiber: 4 },
      { timing: '6:30 PM — Post Workout', meal: 'Whey Shake + Fruit', quantity: '1 shake + 1 fruit', calories: Math.round(calories * 0.12), protein: Math.max(18, Math.round(protein * 0.12)), carbs: 30, fat: 3, fiber: 3 },
      { timing: '8:30 PM — Snack', meal: 'Paneer / Yogurt', quantity: '150g paneer or 200g yogurt', calories: Math.round(calories * 0.10), protein: Math.max(12, Math.round(protein * 0.10)), carbs: 20, fat: 10, fiber: 2 },
      { timing: '9:30 PM — Dinner', meal: 'Salmon + Rice + Veg', quantity: '150g salmon + 150g rice + 200g veg', calories: Math.round(calories * 0.28), protein: Math.max(26, Math.round(protein * 0.28)), carbs: 52, fat: 16, fiber: 10 },
    ];
    return base;
  }

  function getDietMeals(dietType, monthlyBudget, selectedMonth, monthCount, calorieTarget, proteinTarget, workoutTime, currentWeight, targetWeight, timelineMonths, goal) {
    const vegetarianMode = /vegetarian|vegan/i.test(String(dietType || ''));
    const budget = Number(monthlyBudget) || 0;
    const currentKg = Number(currentWeight) || 0;
    const targetKg = Number(targetWeight) || currentKg;
    const months = Math.max(1, Number(timelineMonths) || 1);
    const goalText = String(goal || '').toLowerCase();
    const maintenance = currentKg > 0 ? Math.max(1800, Math.round(currentKg * 30)) : Number(calorieTarget) || 2200;
    let calories = Number(calorieTarget) || maintenance;
    let protein = Number(proteinTarget) || 150;

    if (currentKg > 0) {
      if (goalText.includes('loss') || goalText.includes('cut') || goalText.includes('fat')) {
        const deficit = Math.min(700, Math.max(250, Math.abs(targetKg - currentKg) * 180 / months));
        calories = Math.max(1400, maintenance - deficit);
        protein = Math.max(110, Math.round(currentKg * 1.8));
      } else if (goalText.includes('gain') || goalText.includes('bulk') || goalText.includes('muscle')) {
        const surplus = Math.min(500, Math.max(180, Math.abs(targetKg - currentKg) * 150 / months));
        calories = maintenance + surplus;
        protein = Math.max(120, Math.round(currentKg * 2.1));
      } else {
        calories = maintenance;
        protein = Math.max(110, Math.round(currentKg * 1.7));
      }
    }

    const budgetFactor = budget < 2500 ? 0.9 : budget < 5000 ? 1 : 1.12;
    const rangeFactor = 1 + ((Number(selectedMonth) || 1) / Math.max(1, Number(monthCount) || 1)) * 0.12;
    const plan = buildBasePlan(dietType, calories * budgetFactor * rangeFactor, protein * (budget > 5000 ? 1.08 : 1), vegetarianMode);
    const withTiming = plan.map((meal, index) => {
      const timings = ['7:00 AM — Breakfast', '1:00 PM — Lunch', '4:30 PM — Pre Workout', '6:30 PM — Post Workout', '8:30 PM — Snack', '9:30 PM — Dinner'];
      return { ...meal, timing: timings[index] || meal.timing };
    });
    return { firstHalf: withTiming, secondHalf: withTiming.map((meal) => ({ ...meal })) };
  }

  window.getDietMeals = getDietMeals;
  window.getDietMealsExternal = getDietMeals;
})();
