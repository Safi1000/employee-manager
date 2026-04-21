import { useNavigate } from "react-router";
import { Shield, Users, DollarSign } from "lucide-react";

export default function RoleSelection() {
  const navigate = useNavigate();

  const roles = [
    {
      title: "Super Admin",
      description: "Full system access and control",
      icon: Shield,
      path: "/super-admin",
      color: "bg-blue-50 hover:bg-blue-100 border-blue-200",
      iconColor: "text-blue-600",
    },
    {
      title: "HR",
      description: "Employee and attendance management",
      icon: Users,
      path: "/hr",
      color: "bg-green-50 hover:bg-green-100 border-green-200",
      iconColor: "text-green-600",
    },
    {
      title: "Accounts",
      description: "Payroll and financial management",
      icon: DollarSign,
      path: "/accounts",
      color: "bg-purple-50 hover:bg-purple-100 border-purple-200",
      iconColor: "text-purple-600",
    },
  ];

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-8">
      <div className="max-w-4xl w-full">
        <div className="text-center mb-16">
          <h1 className="text-4xl mb-3 text-slate-900">CRM System</h1>
          <p className="text-slate-500">Select your role to continue</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {roles.map((role) => (
            <button
              key={role.path}
              onClick={() => navigate(`/login?role=${encodeURIComponent(role.path)}`)}
              className={`${role.color} p-8 rounded-lg border transition-all duration-200 text-left group`}
            >
              <role.icon className={`w-10 h-10 ${role.iconColor} mb-6`} strokeWidth={1.5} />
              <h2 className="text-xl mb-2 text-slate-900">{role.title}</h2>
              <p className="text-sm text-slate-600">{role.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
