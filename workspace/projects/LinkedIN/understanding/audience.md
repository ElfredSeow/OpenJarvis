Gemini said
Markdown
# Target Audience & Core Needs: AIS Project Management Tool

This document defines the primary and secondary target audiences for the **AIS Project Management Tool** and details exactly what they care about based on the technical architecture of the application.

---

## 1. Primary Audiences

### Technical Project Managers (TPMs) & Scrum Masters
TPMs sit at the intersection of development and operations. They need structural integrity in data tracking without the friction of heavy enterprise tooling.

* **What they care about:**
    * **Data Integrity & Clean Reporting:** They want to ensure project types and workflows map to uniform keys without developer typos.
    * **Deadlines & Tracking Velocity:** Visually monitoring work through clear, deterministic status progressions.
    * **Portability:** The ability to pull data out easily for stakeholder syncs.
* **How the tool solves it:** * Enforces strict validator architectures (`AISProjectManagerSchema`).
    * Provides deterministic state transitions through pre-mapped enums (`AISProjectManagerStatusKeyToLabel`).
    * Features single-click global exports via the `ExportProjectsDialog`.

### Media Operations Leads & Creative Producers
Creative production and tech often disconnect because asset tracking typically lives separately from engineering sprint logs. These users need to see creative files deeply nested within the software lifecycle.

* **What they care about:**
    * **Asset Association:** Mapping specific production deliverables, design mockups, and final video/image URLs straight to task tickets.
    * **Context in Situ:** Reviewing project dependencies and assets without opening five separate browser tabs.
* **How the tool solves it:**
    * Includes a dedicated schema engineered for media assets (`ProjectMediaURLSchema`).
    * Surfaces specific item metadata right inside the layout using the `ProjectDetailModal`.

---

## 2. Secondary Audiences

### Product Owners (POs) & Product Managers (PMs)
POs care about high-level milestones, roadmap velocity, and rapid task creation during grooming sessions.

* **What they care about:**
    * **Low Friction Creation:** Adding new ideas, requirements, or projects quickly during live meetings.
    * **Scannable Health Checks:** Glancing at a single dashboard to see what is blocked or ready for review.
* **How the tool solves it:**
    * Streamlines entry through the dedicated `CreateProjectDialog`.
    * Provides a clean, visual canvas featuring responsive `KanbanCard` stacks for instant overview analytics.

### Software Engineers & Full-Stack Developers
Engineers hate complex, sluggish project tracking systems that pull them away from writing code. 

* **What they care about:**
    * **Snappy UX:** Lightning-fast state updates and minimal clicks to update a ticket status.
    * **Predictability:** Robust schemas that don't allow corrupted states or crashing front-ends.
* **How the tool solves it:**
    * Built on a lightweight React setup (`app.tsx`) with instant drag/click state modifications.
    * Utilizes frontend validators (`UpdateAISProjectManagerSchema`) to guarantee seamless app state changes.

---

## 3. Audience Value Mapping Summary

| Audience Segment | Core Pain Point | Core Feature Value |
| :--- | :--- | :--- |
| **Technical PMs** | Broken project configurations and messy team logs. | Schema-driven workflow fields (`AISProjectManagerSchema`). |
| **Media Ops** | Creative asset links scattered in Slack/Drive. | Native media link schemas (`ProjectMediaURLSchema`). |
| **Product Owners** | Heavy UI overhead when creating and tracking items. | Lightning-fast creation dialogs and Kanban metrics. |
| **Developers** | Slow-loading interfaces and bloated tooling features. | Clean, structured SPA layouts with high performance. |