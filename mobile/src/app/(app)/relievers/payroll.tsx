import React from "react";
import Payroll from "../../../screens/workforce/Payroll";
import { page } from "../../../navigation/page";

export default page("/payroll", () => <Payroll relieversOnly />);
