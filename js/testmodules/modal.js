// js/testmodules/modal.js

export const ModalManager = {
    /**
     * Opens a dialog element by its ID and locks background scrolling.
     */
    open: (modalId) => {
        const dialog = document.getElementById(modalId);
        if (dialog && typeof dialog.showModal === 'function') {
            dialog.showModal();
            // Prevent the background body from scrolling while the modal is open
            document.body.style.overflow = 'hidden'; 
        } else {
            console.error(`Dialog ${modalId} not found or <dialog> not supported.`);
        }
    },

    /**
     * Closes a dialog element by its ID and restores background scrolling.
     */
    close: (modalId) => {
        const dialog = document.getElementById(modalId);
        if (dialog && dialog.open) {
            dialog.close();
            // Restore background scrolling
            document.body.style.overflow = ''; 
        }
    },

    /**
     * Attaches global listeners for backdrop clicks, Escape key, and close buttons.
     * Call this once during app initialization.
     */
    initGlobalListeners: () => {
        // 1. Close when clicking the dark backdrop outside the modal content
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (target.tagName === 'DIALOG' && target.open) {
                const rect = target.getBoundingClientRect();
                const isInDialog = (
                    rect.top <= event.clientY &&
                    event.clientY <= rect.top + rect.height &&
                    rect.left <= event.clientX &&
                    event.clientX <= rect.left + rect.width
                );
                
                if (!isInDialog) {
                    target.close();
                    document.body.style.overflow = '';
                }
            }
        });

        // 2. Unlock scroll when the native Escape key closes the dialog
        document.addEventListener('cancel', (event) => {
            if (event.target.tagName === 'DIALOG') {
                document.body.style.overflow = '';
            }
        }, true);

        // 3. Automatically wire up all 'close-btn' elements
        document.addEventListener('click', (event) => {
            // Find if the clicked element or its parent is the close button
            const closeBtn = event.target.closest('.close-btn');
            if (closeBtn) {
                const dialog = closeBtn.closest('dialog');
                if (dialog) {
                    // Prevent default form submission if it's in a form
                    event.preventDefault(); 
                    dialog.close();
                    document.body.style.overflow = '';
                }
            }
        });
    }
};
