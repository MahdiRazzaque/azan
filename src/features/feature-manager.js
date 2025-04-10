import { requireAuth } from '../auth/auth.js';
import { scheduleNamazTimers } from '../scheduler/scheduler.js';
import { appConfig } from '../config/config-validator.js';
import { TEST_MODE, TEST_START_TIME } from '../utils/utils.js';

// Feature state management - read from appConfig
function getFeatureStates() {
    return {
        azanEnabled: appConfig?.features?.azanEnabled ?? true,
        announcementEnabled: appConfig?.features?.announcementEnabled ?? true,
        systemLogsEnabled: appConfig?.features?.systemLogsEnabled ?? false
    };
}

// TEST_MODE is now defined in utils.js, not in MongoDB
function getTestModeConfig() {   
    return {
        enabled: TEST_MODE,
        startTime: TEST_MODE ? '02:00:00' : "00:00:00",
        timezone: "Europe/London"
    };
}

// Setup feature routes
function setupFeatureRoutes(app) {
    // Get feature states
    app.get('/api/features', (req, res) => {
        const featureStates = getFeatureStates();
        res.json(featureStates);
    });    // Update feature states
    app.post('/api/features', requireAuth, async (req, res) => {
        console.log('Received feature update request:', req.body);
        const { azanEnabled, announcementEnabled, systemLogsEnabled } = req.body;

        try {
            // Import updateConfig dynamically to avoid circular dependencies
            const { updateConfig } = await import('../config/config-service.js');
            
            // Create updated features object based on current state
            const currentFeatures = getFeatureStates();
            const updatedFeatures = { ...currentFeatures };
            
            // Update feature states
            let hasChanges = false;
            if (typeof azanEnabled === 'boolean') {
                console.log('Updating azanEnabled to:', azanEnabled);
                updatedFeatures.azanEnabled = azanEnabled;
                hasChanges = true;
            }
            if (typeof announcementEnabled === 'boolean') {
                console.log('Updating announcementEnabled to:', announcementEnabled);
                updatedFeatures.announcementEnabled = announcementEnabled;
                hasChanges = true;
            }
            if (typeof systemLogsEnabled === 'boolean') {
                console.log('Updating systemLogsEnabled to:', systemLogsEnabled);
                updatedFeatures.systemLogsEnabled = systemLogsEnabled;
                hasChanges = true;
            }

            if (hasChanges) {
                // Update features in MongoDB
                await updateConfig('features', updatedFeatures);

                // Reschedule timers with new feature states
                await scheduleNamazTimers();
            }

            res.json({ success: true, features: getFeatureStates() });
        } catch (error) {
            console.error('Error updating features:', error);
            res.status(500).json({ 
                success: false, 
                message: 'Error updating features',
                error: error.message
            });
        }
    });

    // Get test mode configuration
    app.get('/api/test-mode', (req, res) => {
        const testModeConfig = getTestModeConfig();
        res.json(testModeConfig);
    });    // Update test mode configuration
    app.post('/api/test-mode', requireAuth, async (req, res) => {
        console.log('Received test mode update request:', req.body);
        
        return res.status(400).json({
            success: false,
            message: 'TEST_MODE is now defined directly in src/utils/utils.js and cannot be modified via API'
        });
        
        // Note: To modify TEST_MODE, edit the utils.js file directly
    });
}

export {
    setupFeatureRoutes,
    getFeatureStates,
    getTestModeConfig
};