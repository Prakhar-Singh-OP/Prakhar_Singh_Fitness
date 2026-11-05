(function () {
  function getDietMeals(...args) {
    if (typeof window.buildDietMealPlan !== 'function') {
      throw new Error('The diet planner is unavailable because its nutrition data has not loaded.');
    }
    return window.buildDietMealPlan(...args);
  }

  window.getDietMeals = getDietMeals;
  window.getDietMealsExternal = getDietMeals;
})();
