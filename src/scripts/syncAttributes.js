#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration for different objects
const objectConfigs = {
  members: {
    objectId: 'c3a9bb82-ec1a-431e-99fe-459da161d794',
    jsonFilePath: path.join(__dirname, '../objects/members/attributes.json'),
  },
  leads: {
    objectId: 'ab6d4a3b-621f-40b1-9cc2-1c96cd480af7',
    jsonFilePath: path.join(__dirname, '../objects/leads/attributes.json'),
  },
  deals: {
    objectId: 'a93a7eff-aa5d-4526-90a7-0eae8e387eb6',
    jsonFilePath: path.join(__dirname, '../objects/deals/attributes.json'),
  },
  companies: {
    objectId: '26f4002b-22f9-4631-9775-45599bfc58c4',
    jsonFilePath: path.join(__dirname, '../objects/companies/attributes.json'),
  },
};

/**
 * Synchronizes attributes between a local JSON mapping file and Attio
 * @param {Object} options Configuration options
 * @param {string} options.objectId The Attio object ID
 * @param {string} options.jsonFilePath Path to the JSON mapping file
 * @param {string} [options.attioBaseUrl] Attio API base URL
 * @param {string} [options.token] Attio API token
 * @param {boolean} [options.createBackup=true] Whether to create a backup of the JSON file
 * @param {boolean} [options.importMissing=false] Whether to import attributes from Attio that are not in the JSON
 * @returns {Promise<{updated: boolean, mapping: Object}>} Result of the sync operation
 */
async function syncAttributes(options) {
  const {
    objectId,
    jsonFilePath,
    attioBaseUrl = process.env.ATTIO_BASE_URL || 'https://api.attio.com/v2',
    token = process.env.ATTIO_API_TOKEN ||
      '80c06c5191d58b09022f08bd871db4c752cfcb0eb1bcc9a6d0914ded30c523d7',
    createBackup = true,
    importMissing = false,
  } = options;

  // --- HELPER FUNCTIONS ---
  // Add error handling and retry logic for API calls
  async function makeApiRequest(fn, retries = 3, delay = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error.response && error.response.status === 429) {
          // Rate limiting - wait longer
          const waitTime = delay * Math.pow(2, attempt);
          console.log(
            `Rate limited. Retrying in ${waitTime}ms (attempt ${attempt}/${retries})...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        } else if (attempt < retries) {
          console.log(
            `Request failed. Retrying in ${delay}ms (attempt ${attempt}/${retries})...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }

  // Get existing attributes from Attio
  async function getExistingAttributes() {
    try {
      return await makeApiRequest(async () => {
        const response = await axios.get(
          `${attioBaseUrl}/objects/${objectId}/attributes`,
          {
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${token}`,
            },
          }
        );
        return response.data.data || [];
      });
    } catch (error) {
      console.error(
        'Error fetching existing attributes:',
        error.response ? error.response.data : error.message
      );
      throw error;
    }
  }

  // Create an attribute in Attio
  async function createAttribute(attributeMapping) {
    try {
      return await makeApiRequest(async () => {
        // Create a copy of the attribute data without the relationship field
        const attributeData = { ...attributeMapping.attio };
        delete attributeData.relationship;

        const payload = { data: attributeData };
        const response = await axios.post(
          `${attioBaseUrl}/objects/${objectId}/attributes`,
          payload,
          {
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              authorization: `Bearer ${token}`,
            },
          }
        );
        return response.data.data;
      });
    } catch (error) {
      console.error(
        'Error creating attribute:',
        error.response ? error.response.data : error.message
      );
      throw error;
    }
  }

  // Add a function to backup the mapping file before modifications
  function backupMappingFile(filePath) {
    const backupPath = `${filePath}.backup-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, backupPath);
      console.log(`Created backup at ${backupPath}`);
    } catch (err) {
      console.warn(`Warning: Could not create backup: ${err.message}`);
    }
  }

  // MAIN LOGIC
  // Load local JSON mapping file
  let mapping;
  try {
    const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
    mapping = JSON.parse(fileContent);
  } catch (err) {
    console.error('Error reading mapping file:', err);
    throw err;
  }

  // Create a backup before making changes
  if (createBackup) {
    backupMappingFile(jsonFilePath);
  }

  // Get existing attributes from Attio
  const existingAttributes = await getExistingAttributes();

  // Create a lookup based on api_slug for easier comparison
  const existingBySlug = existingAttributes.reduce((acc, attr) => {
    if (attr.api_slug) {
      acc[attr.api_slug] = attr;
    }
    return acc;
  }, {});

  // Create a lookup of existing attributes in the JSON by attribute_id
  const mappingByAttributeId = Object.values(mapping).reduce((acc, attr) => {
    if (attr.attio?.attribute_id) {
      acc[attr.attio.attribute_id] = true;
    }
    return acc;
  }, {});

  // mapping file is expected to be an object with keys for each attribute
  let updated = false;
  for (const key of Object.keys(mapping)) {
    const attributeMapping = mapping[key];
    const apiSlug = attributeMapping.attio.api_slug;
    if (existingBySlug[apiSlug]) {
      console.log(
        `Attribute ${apiSlug} already exists (ID: ${existingBySlug[apiSlug].id.attribute_id}).`
      );
      // Update mapping with attribute id if not present
      if (!attributeMapping.attio.attribute_id) {
        attributeMapping.attio.attribute_id =
          existingBySlug[apiSlug].id.attribute_id;
        updated = true;
      }
    } else {
      console.log(`Creating attribute ${apiSlug}...`);
      try {
        const created = await createAttribute(attributeMapping);
        console.log(
          `Created attribute ${apiSlug} with ID: ${created.id.attribute_id}`
        );
        // Save the created attribute id back into your JSON mapping.
        attributeMapping.attio.attribute_id = created.id.attribute_id;
        updated = true;
      } catch (err) {
        console.error(`Failed to create attribute ${apiSlug}.`);
      }
    }
  }

  // Import attributes from Attio that are not in the JSON
  if (importMissing) {
    console.log('Checking for attributes in Attio that are not in the JSON...');
    let importCount = 0;

    for (const attr of existingAttributes) {
      // Skip system attributes
      if (attr.api_slug.startsWith('system_')) continue;

      // Skip attributes that are already in the mapping
      if (mappingByAttributeId[attr.id.attribute_id]) continue;

      // Generate a key for the new attribute
      let key = attr.api_slug.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase()
      );
      if (key.match(/^[0-9]/)) key = 'attr' + key;

      // Ensure the key is unique
      let uniqueKey = key;
      let counter = 1;
      while (mapping[uniqueKey]) {
        uniqueKey = `${key}${counter}`;
        counter++;
      }

      // Add the attribute to the mapping
      mapping[uniqueKey] = {
        database: {
          // Leave database mapping empty as requested
        },
        attio: {
          title: attr.title,
          description: attr.description || '',
          api_slug: attr.api_slug,
          type: attr.type,
          is_required: attr.is_required,
          is_unique: attr.is_unique,
          is_multiselect: attr.is_multiselect,
          default_value: attr.default_value,
          config: attr.config || {},
          attribute_id: attr.id.attribute_id,
        },
      };

      console.log(
        `Imported attribute "${attr.title}" (${attr.api_slug}) as "${uniqueKey}"`
      );
      importCount++;
      updated = true;
    }

    console.log(`Imported ${importCount} attributes from Attio.`);
  }

  // If we made updates to the mapping, write back to file.
  if (updated) {
    try {
      fs.writeFileSync(jsonFilePath, JSON.stringify(mapping, null, 2), 'utf8');
      console.log('Updated mapping file with new attribute IDs.');
    } catch (err) {
      console.error('Error writing updated mapping file:', err);
      throw err;
    }
  } else {
    console.log('No updates to mapping file.');
  }

  return { updated, mapping };
}

// If this script is run directly, use command line arguments
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let objectName = null;
  let customObjectId = null;
  let customJsonFilePath = null;
  let importMissing = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--object' && i + 1 < args.length) {
      objectName = args[i + 1];
      i++;
    } else if (args[i] === '--object-id' && i + 1 < args.length) {
      customObjectId = args[i + 1];
      i++;
    } else if (args[i] === '--json-file' && i + 1 < args.length) {
      customJsonFilePath = args[i + 1];
      i++;
    } else if (args[i] === '--import-missing') {
      importMissing = true;
    }
  }

  // Determine which configuration to use
  let syncConfig = {};

  if (objectName && objectConfigs[objectName]) {
    // Use predefined configuration
    syncConfig = objectConfigs[objectName];
    console.log(`Using predefined configuration for object: ${objectName}`);
  } else if (customObjectId && customJsonFilePath) {
    // Use custom configuration
    syncConfig = {
      objectId: customObjectId,
      jsonFilePath: customJsonFilePath,
    };
    console.log(`Using custom configuration with provided parameters`);
  } else {
    console.error(`
Error: Insufficient parameters provided.
Usage: 
  node syncAttributes.js --object <objectName> [--import-missing]
  OR
  node syncAttributes.js --object-id <id> --json-file <path> [--import-missing]

Available objects: ${Object.keys(objectConfigs).join(', ')}
    `);
    process.exit(1);
  }

  // Add the importMissing option
  syncConfig.importMissing = importMissing;

  // Run the sync function
  syncAttributes(syncConfig)
    .then((result) => {
      console.log(`Sync completed successfully. Updated: ${result.updated}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Unhandled error in main process:', error);
      process.exit(1);
    });
}

// Export the sync function for use in other scripts
module.exports = { syncAttributes };
