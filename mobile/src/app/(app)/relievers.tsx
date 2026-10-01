import React from "react";
import Timesheet from "../../screens/attendance/Timesheet";
import { page } from "../../navigation/page";

export default page("/relievers", () => <Timesheet relieversOnly />);
