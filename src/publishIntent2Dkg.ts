import {
  IAgentRuntime,
  Memory,
  State,
  elizaLogger,
  ModelClass,
  HandlerCallback,
  ActionExample,
  type Action,
  composeContext,
  generateObjectArray,
} from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";

let DkgClient: any = null;

// SPARQL query to find existing professional intentions for a user
const EXISTING_INTENTIONS_QUERY = `
PREFIX schema: <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>

SELECT ?intent ?description ?direction ?type
WHERE {
  {
    SELECT ?intent (SAMPLE(?description) as ?description) (SAMPLE(?direction) as ?direction) (SAMPLE(?type) as ?type)
    WHERE {
      ?person a schema:Person ;
              foaf:account ?account .
      ?account a foaf:OnlineAccount ;
               foaf:accountServiceHomepage "{{platform}}" ;
               foaf:accountName "{{username}}" .
      ?person datalatte:hasIntent ?intent .
      ?intent a datalatte:intent ;
              datalatte:intentCategory "professional" ;
              schema:description ?description ;
              datalatte:intentDirection ?direction ;
              datalatte:intentType ?type .
    }
    GROUP BY ?intent
    ORDER BY DESC(?intent)
  }
}`;

const KGExtractionTemplate = `
TASK: Transform conversation data into valid schema.org/FOAF compliant JSON-LD for professional intentions, considering existing intentions in DKG

Recent Messages:
{{recentMessages}}

Existing knowledge related to the person:


SHACL Shapes for Validation:
@prefix sh:       <http://www.w3.org/ns/shacl#> .
@prefix xsd:      <http://www.w3.org/2001/XMLSchema#> .
@prefix schema:   <http://schema.org/> .
@prefix foaf:     <http://xmlns.com/foaf/0.1/> .
@prefix datalatte:<https://datalatte.com/ns/> .

#############################
# Person Shape (Private)
#############################
# We use foaf:Person as the target class. Additional private properties (background,
# domain, privateDetails) and relationships to intents and projects are modeled using
# custom properties in the datalatte namespace.
datalatte:PersonShape
  a sh:NodeShape ;
  sh:targetClass foaf:Person ;
  
  # hasAccount: expects an embedded account node
  sh:property [
      sh:path datalatte:hasAccount ;
      sh:node datalatte:AccountShape ;
      sh:minCount 1 ;
      sh:description "The account information including platform and username." ;
  ] ;
  
  # Optional name (using foaf:name)
  sh:property [
      sh:path foaf:name ;
      sh:datatype xsd:string ;
      sh:minCount 0 ;
      sh:description "The person's name (optional)." ;
  ] ;
  
  # Background: a private biography or context
  sh:property [
      sh:path datalatte:background ;
      sh:datatype xsd:string ;
      sh:minCount 1 ;
      sh:description "Private biography or context (e.g., 'Founder of an AI analytics startup')." ;
  ] ;
  
  # Domain: primary field (e.g., Web3, DeFi, NFT)
  sh:property [
      sh:path datalatte:domain ;
      sh:datatype xsd:string ;
      sh:minCount 1 ;
      sh:description "Primary field (e.g., Web3, DeFi, NFT)." ;
  ] ;
  
  # Private details: any additional personal/sensitive data
  sh:property [
      sh:path datalatte:privateDetails ;
      sh:datatype xsd:string ;
      sh:minCount 0 ;
      sh:description "Additional personal or sensitive details (private)." ;
  ] ;
  
  # Relationship to a public (anonymized) Intent
  sh:property [
      sh:path datalatte:hasIntent ;
      sh:class datalatte:Intent ;
      sh:minCount 0 ;
      sh:description "Link to the public, anonymized intent node." ;
  ] ;
  
  # Relationship to a private Project
  sh:property [
      sh:path datalatte:hasProject ;
      sh:class datalatte:Project ;
      sh:minCount 0 ;
      sh:description "Link to private project details." ;
  ] .

#############################
# Account Shape (for hasAccount)
#############################
# Models the account object attached to a Person. This shape requires a platform and username.
datalatte:AccountShape
  a sh:NodeShape ;
  sh:property [
    sh:path datalatte:platform ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Platform of the account (e.g., Twitter, GitHub)." ;
  ] ;
  sh:property [
    sh:path datalatte:username ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Username on the given platform." ;
  ] .

#############################
# Intent Shape (Public & Anonymized)
#############################
# An Intent node captures the public matchmaking request. It is linked to a Project
# (using the relatedTo property) and contains a summary, desired connections,
# public project description, and a challenge summary.
datalatte:IntentShape
  a sh:NodeShape ;
  sh:targetClass datalatte:Intent ;
  
  sh:property [
    sh:path datalatte:summary ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "An anonymized summary of what the user seeks (e.g., 'Seeking a marketing expert to scale digital outreach')." ;
  ] ;
  sh:property [
    sh:path datalatte:desiredConnections ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A list or category of experts or partners the user wants to meet." ;
  ] ;
  sh:property [
    sh:path datalatte:projectDescription ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A public version of the project description (anonymized)." ;
  ] ;
  sh:property [
    sh:path datalatte:challenge ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A summary of the challenge or goal that the user is facing." ;
  ] ;
  sh:property [
    sh:path datalatte:relatedTo ;
    sh:class datalatte:Project ;
    sh:minCount 0 ;
    sh:description "Links the intent to a private project node." ;
  ] .

#############################
# Project Shape (Private)
#############################
# A Project node contains details about the user's project. It includes a title,
# description, classification type, domain, and technical details.
datalatte:ProjectShape
  a sh:NodeShape ;
  sh:targetClass datalatte:Project ;
  
  sh:property [
    sh:path foaf:name ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Project title or name (e.g., 'NFT Art Marketplace')." ;
  ] ;
  sh:property [
    sh:path schema:description ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "A summary of what the project is about." ;
  ] ;
  sh:property [
    sh:path datalatte:type ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Classification of the project (e.g., marketplace, protocol, DAO tool, game, platform)." ;
  ] ;
  sh:property [
    sh:path datalatte:domain ;
    sh:datatype xsd:string ;
    sh:minCount 1 ;
    sh:description "Domain of the project (e.g., Web3, blockchain, metaverse)." ;
  ] ;
  sh:property [
    sh:path datalatte:techStack ;
    sh:datatype xsd:string ;
    sh:minCount 0 ;
    sh:description "Technical details or technology stack used in the project." ;
  ] .



Guidelines:
1. First analyze if the intent and project from conversation matches or updates any existing intention and project:
   - If exact match exists (same core intention, no new details) -> return empty array
   - If similar intent/project exists but has new details -> use existing intention/project ID and merge details
   - If completely new intention/project -> use the provided new ID
2. For existing updates:
   - Keep all existing fields
   - Only add or update fields that have new information
   - Use the exact ID from the matching existing knowledge asset
3. For new intents and projects:
   - Use the provided new ID
   - Fill all fields that can be extracted from conversation
4. All fields must match their defined datatypes and value constraints

Format response as array:
[
  {
    "analysis": {
      "matchType": "exact_match" | "update_existing" | "new_information",
      "existingIntentionId": "<id of matching intention if update_existing>",
      "existingProjectId": "<id of matching project if update_existing>",
      "reason": "<explanation of the decision>"
    },
    "public": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/"
      },
      "@type": "datalatte:Intent",
      "@id": "urn:intent:{{intentid}}",
      "datalatte:summary": "<Anonymized summary of what the user seeks, e.g., 'Seeking a marketing expert to scale digital outreach'>",
      "datalatte:desiredConnections": [
        "<expertise type1>",
        "<expertise type2>"
      ],
      "datalatte:projectDescription": "<Public description of the project, anonymized>",
      "datalatte:challenge": "<Summary of the challenge or goal user seeks>",
      "schema:url": "<Extracted URL if mentioned>",
      "datalatte:intentCategory": "professional",
      "datalatte:relatedTo": "urn:project:{{projectid}}"
    },
    "private": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/",
        "foaf": "http://xmlns.com/foaf/0.1/"
      },
      "@type": "foaf:Person",
      "@id": "urn:uuid:{{uuid}}",
      "foaf:account": {
        "@type": "foaf:OnlineAccount",
        "foaf:accountServiceHomepage": "{{platform}}",
        "foaf:accountName": "{{username}}"
      },
      "datalatte:background": "<Private biography or contextual background (e.g., 'Founder of an AI analytics startup')>",
      "datalatte:knowledgeDomain": "<Primary field, e.g., 'Web3', 'DeFi', 'NFT'>",
      "datalatte:privateDetails": "<Any additional sensitive details>",
      "datalatte:hasIntent": {
        "@type": "datalatte:Intent",
        "@id": "urn:intent:{{intentid}}",
      },
      "datalatte:hasProject": {
        "@type": "datalatte:Project",
        "@id": "urn:project:{{projectid}}",
        "foaf:name": "<Project title, e.g., 'NFT Art Marketplace'>",
        "schema:description": "<Project description summary>",
        "datalatte:type": "<Classification, e.g., 'marketplace', 'protocol', 'DAO tool', 'game', 'platform'>",
        "datalatte:domain": "<Project domain, e.g., 'Web3', 'blockchain', 'metaverse'>",
        "datalatte:techStack": "<Technical details or technology stack used>"
      }
    }
  }
]

- If nothing new is found or conversation does not reveal any information that can be extracted in this template, return []
- If updating existing intent or project, use that intention's ID instead of {{intentid}} as well as existing project's ID instead of {{projectid}}
- Exclude any field from the output if not found in conversation
`;

export const publishIntent2Dkg: Action = {
  name: "PUBLISH_DKG_INTENT",
  similes: ["PUBLISH_INTENTION_TO_DKG", "SAVE_INTENTION_TO_DKG", "STORE_INTENTION_IN_DKG"],
  description: "Publishes intents to the DKG",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const requiredEnvVars = [
      "DKG_ENVIRONMENT",
      "DKG_HOSTNAME",
      "DKG_PORT",
      "DKG_BLOCKCHAIN_NAME",
      "DKG_PUBLIC_KEY",
      "DKG_PRIVATE_KEY",
    ];

    const missingVars = requiredEnvVars.filter((varName) => !runtime.getSetting(varName));

    if (missingVars.length > 0) {
      elizaLogger.error(`Missing required environment variables: ${missingVars.join(", ")}`);
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback: HandlerCallback
  ): Promise<boolean> => {
    try {
      // Initialize DKG client if needed
      if (!DkgClient) {
        DkgClient = new DKG({
          environment: runtime.getSetting("DKG_ENVIRONMENT"),
          endpoint: runtime.getSetting("DKG_HOSTNAME"),
          port: runtime.getSetting("DKG_PORT"),
          blockchain: {
            name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
            publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
            privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
          },
          maxNumberOfRetries: 300,
          frequency: 2,
          contentType: "all",
          nodeApiVersion: "/v1",
        });
      }

      const username = state?.senderName || message.userId;

      // Get platform type from client
      const clients = runtime.clients;
      const client = Object.values(clients)[0];
      let platform = client?.constructor?.name?.replace("ClientInterface", "").toLowerCase();
      if (platform?.endsWith("client")) {
        platform = platform.replace("client", "");
      }

      elizaLogger.info("User platform details:", {
        username,
        platform,
        clientType: client?.constructor?.name,
      });

      // First, check for existing professional intentions in DKG
      const existingIntentionsQuery = EXISTING_INTENTIONS_QUERY.replace("{{platform}}", platform).replace(
        "{{username}}",
        username
      );

      elizaLogger.info("Querying for existing professional intentions:", {
        query: existingIntentionsQuery,
      });

      let existingIntentions;
      existingIntentions = [];      //not doing any query for now
      try {
        // Add a small delay to allow for DKG indexing if needed
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // const queryResult = await DkgClient.graph.query(existingIntentionsQuery, "SELECT");
        // elizaLogger.info("Existing intentions query result:", {
        //   status: queryResult.status,
        //   dataLength: queryResult.data?.length,
        //   data: queryResult.data,
        // });

        // existingIntentions = queryResult.data;
      } catch (error) {
        elizaLogger.error("Error querying existing intentions:", error);
        existingIntentions = [];
      }

      // Update state with recent messages and existing intentions
      if (!state) {
        state = await runtime.composeState(message);
      }
      state = await runtime.updateRecentMessageState(state);

      // Generate a new intention ID that will only be used if needed
      const newIntentionId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newProjectId = `int_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      state.intentid = newIntentionId; // This may be replaced by an existing ID
      state.projectid = newProjectId; // This may be replaced by an existing ID
      state.uuid = message.userId;
      state.platform = platform;
      state.username = username;
      //state.existingIntentions = JSON.stringify(existingIntentions || [], null, 2);

      elizaLogger.info("Generating JSON-LD with context data:", {
        messageId: message.id,
        platform,
        username,
        newIntentionId,
        newProjectId
      });

      const context = composeContext({
        template: KGExtractionTemplate,
        state,
      });

      elizaLogger.info("=== Full KG Extraction Template Prompt ===");
      elizaLogger.info("Template:", {
        fullPrompt: context,
        stateData: {
          recentMessages: state.recentMessages,
          uuid: state.uuid,
          intentid: state.intentid,
          projectid: state.projectid,
          platform: state.platform,
          username: state.username,
        },
      });
      elizaLogger.info("=====================================");

      const result = await generateObjectArray({
        runtime,
        context,
        modelClass: ModelClass.LARGE,
      });

      if (!result || result.length === 0) {
        elizaLogger.info("No professional intention to publish - empty result");
        callback({
          text: "I found that this professional intention is already published in the DKG. No changes needed!",
        });
        return true;
      }

      const firstResult = result[0];
      const analysis = firstResult.analysis;
      elizaLogger.info("Professional intention analysis:", analysis);

      if (analysis.matchType === "exact_match") {
        elizaLogger.info("Exact match found - no updates needed");
        callback({
          text: "I found that this professional intention is already published in the DKG. No changes needed!",
        });
        return true;
      }

      // If it's an update to an existing intention, use that ID
      if (analysis.matchType === "update_existing" && analysis.existingIntentionId) {
        state.intentid = analysis.existingIntentionId;
        elizaLogger.info("Updating existing professional intention:", {
          existingId: analysis.existingIntentionId,
          reason: analysis.reason,
        });
      }

      const { public: publicJsonLd, private: privateJsonLd } = firstResult;

      elizaLogger.info("=== Generated JSON-LD for DKG ===");
      elizaLogger.info("Public JSON-LD:", {
        data: publicJsonLd,
      });
      elizaLogger.info("Private JSON-LD:", {
        data: JSON.stringify(privateJsonLd, null, 2),
      });
      elizaLogger.info("================================");

      // Publish to DKG
      elizaLogger.info("Publishing professional intention to DKG with client config:", {
        environment: runtime.getSetting("DKG_ENVIRONMENT"),
        endpoint: runtime.getSetting("DKG_HOSTNAME"),
        port: runtime.getSetting("DKG_PORT"),
        blockchain: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
      });

      let createAssetResult;
      try {
        elizaLogger.info("Initializing DKG asset creation...");

        createAssetResult = await DkgClient.asset.create(
          {
            public: publicJsonLd,
            private: privateJsonLd,
          },
          { epochsNum: 3 } // keeping this intention in the DKG for 3 months only
        );

        elizaLogger.info("DKG asset creation request completed successfully");
        elizaLogger.info("=== Knowledge Asset Created ===");
        elizaLogger.info(`UAL: ${createAssetResult.UAL}`);
        elizaLogger.info(
          `DKG Explorer Link: ${
            runtime.getSetting("DKG_ENVIRONMENT") === "mainnet"
              ? "https://dkg.origintrail.io/explore?ual="
              : "https://dkg-testnet.origintrail.io/explore?ual="
          }${createAssetResult.UAL}`
        );
        elizaLogger.info("===============================");

        callback({
          text: `Here's your anonymous intent on DKG ($latte brew will come soon): ${
            runtime.getSetting("DKG_ENVIRONMENT") === "mainnet"
              ? "https://dkg.origintrail.io/explore?ual="
              : "https://dkg-testnet.origintrail.io/explore?ual="
            }${createAssetResult.UAL}. In the meanwhile i get back to you with the match, feel free to tell me more about your project and challenges.`,
        });

        return true;
      } catch (error) {
        elizaLogger.error("Error occurred while publishing professional intention to DKG:", error.message);
        if (error.stack) {
          elizaLogger.error("Stack trace:", error.stack);
        }
        if (error.response) {
          elizaLogger.error("Response data:", JSON.stringify(error.response.data, null, 2));
        }
        return false;
      }
    } catch (error) {
      elizaLogger.error("Error in publishIntent2Dkg handler:", error);
      return false;
    }
  },

  examples: [
    [
      {
        user: "DataBarista",
        content: {
          "text": "Great, I'll post an introduction and tag both you and a growth specialist from my network as soon as I find a match! Wish to add any additional details?",
          "action": "(PUBLISH_DKG_INTENT)"
        },
      }
    ],
    [
      {
        "user": "DataBarista",
        "content": {
          "text": "Great, I'll post an introduction and tag both you and a crowdfunding expert from my network as soon as I find a match! Wish to add any additional details? (PUBLISH_DKG_INTENT)",
          "action": "(PUBLISH_DKG_INTENT)"
        }
      },
      {
        "user": "{{user2}}",
        "content": {
          "text": "Yeah it would be great if they had previous experience in blockchain and crypto."
        }
      },
      {
        "user": "DataBarista",
        "content": {
          "text": "Gotcha adding it to your brew.",
          "action": "(PUBLISH_DKG_INTENT)"
        }
      }
    ]
  ] as ActionExample[][],
} as Action;
