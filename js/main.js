// js/main.js

import { initializeUI } from './modules/ui.js';
import { checkAndClearOldData } from './modules/utils.js';

/**
 * This is the main entry point of the application.
 * It waits for the DOM to be fully loaded before running any scripts.
 */
document.addEventListener('DOMContentLoaded', () => {
    // A utility function to clear incompatible data from older versions
    checkAndClearOldData();

    // Kicks off the entire application by setting up the map,
    // auth listeners, and all button click events.
    initializeUI();
});
