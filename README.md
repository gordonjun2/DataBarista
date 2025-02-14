# DataBarista

**“I'm that Barista who remembers your stories & might just know someone you should meet!”**

DataBarista is a privacy-preserving AI agent designed to connect people with the right collaborators and opportunities. It leverages a hybrid knowledge graph (public + private) powered by [OriginTrail DKG](https://origintrail.io/) and the [ElizaOS](https://github.com/eliza-os) framework to securely capture and share matchmaking “intents” without exposing sensitive data.

---

## Table of Contents
- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [Getting Started](#getting-started)
- [Usage](#usage)
- [Future Directions](#future-directions)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Traditional networking—online or at meetups—often yields superficial interactions or irrelevant connections. DataBarista changes this by:
1. **Conversing naturally** to understand a user’s project, challenges, and goals.
2. **Extracting knowledge** into a structured, hybrid knowledge graph.
3. **Publishing anonymized intents** publicly so others can discover collaboration opportunities.
4. **Protecting private details** in an edge node accessible only to DataBarista.

This approach ensures that valuable signals are public (so matches can find you), while personal data stays private.

---

## Key Features

- **Hybrid Public-Private Knowledge Graph**  
  Publicly stores anonymous user “intents” while privately storing personal data and project details.

- **Semantic Matchmaking**  
  Uses SPARQL queries and rule-based filtering to find relevant profiles from the decentralized knowledge graph.

- **Continuous Updates via Twitter**  
  Listens to user tweets and activity to refine knowledge about skills, interests, and current projects in real time.

- **Privacy-Preserving**  
  Only DataBarista can access private user data. Public DKG entries are anonymized, preventing unwanted spam or data leaks.

- **Easy Integration**  
  Built with the [ElizaOS](https://github.com/eliza-os) AI Agent framework, making it straightforward to extend or embed in other systems.

---

## Architecture

Below is a high-level illustration of DataBarista’s flow:

```
   ┌─────────────────────────────────────┐
   │  1. Introduction Post (Social)     │
   └─────────────────────────────────────┘
                │
                ▼
   ┌─────────────────────────────────────┐
   │  DataBarista’s Network             │
   │  (Private Edge Node + Public DKG)  │
   └─────────────────────────────────────┘
                │
                ▼
   ┌─────────────────────────────────────┐
   │  2. publishIntent2DKG Action       │
   └─────────────────────────────────────┘
                │
                ▼
   ┌─────────────────────────────────────┐
   │  3. Serendipity Scenario           │
   │  (Match Found & Introduction)      │
   └─────────────────────────────────────┘
```

1. **User shares a post** or starts a conversation about their needs.  
2. **DataBarista** extracts relevant data, splits it into private (user profile, projects) and public (anonymous intent) JSON-LD, then publishes the public part on the DKG.  
3. **Semantic matching** finds other users with complementary intents or expertise.  
4. **Serendipitous introduction** is made, benefiting both parties.

---

## How It Works

1. **Conversation & Data Extraction**  
   - DataBarista engages in a chat-like dialogue, gathering details about the user’s goals, project, and challenges.  
   - A knowledge extraction pipeline transforms these details into triplets (using custom schemas like `datalatte:Intent`, `datalatte:Project`, etc.).

2. **Public vs. Private Storage**  
   - **Public**: Anonymized “intent” data (e.g., “Looking for a marketing expert”) is published to the OriginTrail DKG, making it discoverable and verifiable.  
   - **Private**: Sensitive info (user background, full project details) is stored on a private edge node accessible only to DataBarista.

3. **Semantic Matchmaking**  
   - SPARQL queries dynamically filter potential matches from the DKG.  
   - A custom matching prompt uses LLM-based reasoning to generate an introduction post, ensuring both sides actually want to connect.

4. **Continuous Updates**  
   - By monitoring Twitter, DataBarista refines its understanding of user expertise and interests, making matches more timely and context-aware.

---

## Getting Started

1. **Clone the Repo**
   ```bash
   git clone https://github.com/amirmabhout/DataBarista.git
   cd DataBarista
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Set Environment Variables**  
   

4. **Run the Agent**
   ```bash
   npm run
   ```
   This starts the ElizaOS-based AI agent, ready to handle conversations and publish to the DKG.

---

## Usage

- **Action: `publishIntent2DKG`**  
  Main entry point for publishing a new user intent. It:
  1. Queries existing data in the DKG to see if there’s already a matching intent.  
  2. If new or updated, publishes anonymized intent data publicly and private user data to the edge node.  
  3. Performs a semantic match and, if successful, posts an introduction for both parties.

- **Twitter Integration**  
  Configure a Twitter client so DataBarista can listen for relevant tweets. This data feeds the agent’s knowledge graph for more accurate, real-time matchmaking.

- **SPARQL Queries**  
  SPARQL is used to fetch and match user profiles based on domains, challenges, and desired connections. See `EXISTING_INTENTIONS_QUERY` and `generateMatchingQuery` for details.

---

## Future Directions

- **TEE (Trusted Execution Environment)**  
  Integrate a verifiable environment (e.g., Intel SGX) to further reduce data leakage and assure third parties of data integrity.

- **Enhanced Matching Algorithms**  
  Incorporate advanced embeddings or ML-based similarity checks for more nuanced matchmaking beyond simple domain matching.

- **Multi-Platform Listening**  
  Expand beyond Twitter to GitHub, LinkedIn, or Discord for a broader view of user activity and interests.

---

## Contributing

Contributions are welcome! If you have suggestions for new features, improvements, or bug fixes, please open an issue or submit a pull request. For major changes, consider discussing them first to ensure alignment with the project’s goals.

---

## License

[MIT](LICENSE) – Feel free to use, modify, and distribute this project as allowed by the MIT license.

---

**Thank you for checking out DataBarista!** If you have any questions or ideas, feel free to open an issue or reach out. Together, we can make networking more meaningful, private, and serendipitous.
