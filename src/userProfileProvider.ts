import { Provider, IAgentRuntime, Memory, State, elizaLogger } from "@elizaos/core";
// @ts-ignore
import DKG from "dkg.js";

let DkgClient: any = null;

//TODO; currently sparql query is only getting latest intent ids, but later should get all unique ids and their latest revision timestamp

// SPARQL query to find structured user data
const USER_DATA_QUERY = `
PREFIX schema:    <http://schema.org/>
PREFIX datalatte: <https://datalatte.com/ns/>
PREFIX foaf:      <http://xmlns.com/foaf/0.1/>
PREFIX rdf:       <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT ?person ?name ?background ?knowledgeDomain ?privateDetails ?personTimestamp
       ?latestIntent ?intentTimestamp ?summary ?allDesiredConnections ?projDesc ?challenge ?url ?relatedProject
       ?latestProject ?projectTimestamp ?projectName ?projectDescriptionFull ?projectType ?projectDomain ?projectTechStack
WHERE {
  # Person info
  {
    SELECT ?person 
           (MAX(?pTs) AS ?personTimestamp)
           (MAX(?nameVal) AS ?name)
           (MAX(?bg) AS ?background)
           (MAX(?kd) AS ?knowledgeDomain)
           (MAX(?pd) AS ?privateDetails)
    WHERE {
      ?person rdf:type foaf:Person ;
              foaf:account ?account .
      ?account a foaf:OnlineAccount ;
               foaf:accountServiceHomepage "{{platform}}" ;
               foaf:accountName "{{username}}" .
      OPTIONAL { ?person foaf:name ?nameVal. }
      OPTIONAL { ?person datalatte:background ?bg. }
      OPTIONAL { ?person datalatte:knowledgeDomain ?kd. }
      OPTIONAL { ?person datalatte:privateDetails ?pd. }
      OPTIONAL { ?person datalatte:revisionTimestamp ?pTs. }
    }
    GROUP BY ?person
  }
  
  # Latest Intent Timestamp per person
  OPTIONAL {
    SELECT ?person (MAX(?it) AS ?intentTimestamp)
    WHERE {
      ?person datalatte:hasIntent ?i .
      ?i rdf:type datalatte:Intent ;
         datalatte:intentCategory "professional" ;
         datalatte:revisionTimestamp ?it .
    }
    GROUP BY ?person
  }
  
  # Latest Intent details joined on that timestamp
  OPTIONAL {
    ?person datalatte:hasIntent ?latestIntent .
    ?latestIntent rdf:type datalatte:Intent ;
                  datalatte:intentCategory "professional" ;
                  datalatte:revisionTimestamp ?intentTimestamp . 
    OPTIONAL { ?latestIntent datalatte:summary ?summary. }
    OPTIONAL { ?latestIntent datalatte:projectDescription ?projDesc. }
    OPTIONAL { ?latestIntent datalatte:challenge ?challenge. }
    OPTIONAL { ?latestIntent schema:url ?url. }
    OPTIONAL { ?latestIntent datalatte:relatedTo ?relatedProject. }
    OPTIONAL { ?latestIntent datalatte:desiredConnections ?allDesiredConnections }
  }
  
  
  # Latest Project Timestamp per person
  OPTIONAL {
    SELECT ?person (MAX(?pt) AS ?projectTimestamp)
    WHERE {
      ?person datalatte:hasProject ?p .
      ?p rdf:type datalatte:Project ;
         datalatte:revisionTimestamp ?pt .
    }
    GROUP BY ?person
  }
  
  # Latest Project details joined on that timestamp
  OPTIONAL {
    ?person datalatte:hasProject ?latestProject .
    ?latestProject rdf:type datalatte:Project ;
                   datalatte:revisionTimestamp ?projectTimestamp ;
                   foaf:name ?projectName ;
                   schema:description ?projectDescriptionFull ;
                   datalatte:type ?projectType ;
                   datalatte:domain ?projectDomain .
    OPTIONAL { ?latestProject datalatte:techStack ?projectTechStack. }
  }
}
`;

const userProfileProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string | null> => {
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
      let platform = client?.constructor?.name?.replace('ClientInterface', '').toLowerCase();
      if (platform?.endsWith('client')) {
        platform = platform.replace('client', '');
      }

      elizaLogger.info("Checking DKG for user data:", {
        username,
        platform,
        clientType: client?.constructor?.name
      });

      // Query for user data
      const userDataQuery = USER_DATA_QUERY
        .replace("{{platform}}", platform)
        .replace("{{username}}", username);

      let userData;
      try {
        const queryResult = await DkgClient.graph.query(userDataQuery, "SELECT");
        elizaLogger.info("User data query result:", {
          status: queryResult.status,
          data: queryResult.data
        });

        userData = queryResult.data;
      } catch (error) {
        elizaLogger.error("Error querying user data:", error);
        return null;
      }

      // If no data found
      if (!userData || userData.length === 0) {
        return `No profile information found in DKG for @${username} on ${platform}.`;
      }

      // Format the found data as JSON-LD
      const jsonLd = {
        "@context": {
          "schema": "http://schema.org/",
          "datalatte": "https://datalatte.com/ns/",
          "foaf": "http://xmlns.com/foaf/0.1/"
        },
        "@graph": userData
      };

      return `
Profile history for @${username} collected through ${platform} interactions with DataBarista sofar:
\`\`\`json
${JSON.stringify(jsonLd, null, 2)}
\`\`\`
Task: Based on users recent conversation, engage in a natural conversation to ask follow up questions to get information that helps finding a better match for the intent user is looking for currently in the conversation.
`;
    } catch (error) {
      elizaLogger.error("Error in userProfileProvider:", error);
      return null;
    }
  }
};

export { userProfileProvider }; 