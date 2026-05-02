import { useState } from "react";
import { Plus, Search } from "lucide-react";
import Header from "../../components/Header";
import Button from "../../components/Button";
import Modal from "../../components/Modal";
import ExportButton from "../../components/ExportButton";
import { exportTable } from "../../lib/excel";

const users = [
  { id: 1, name: "Ahmed Khan", email: "ahmed.khan@company.com", role: "Super Admin", status: "Active" },
  { id: 2, name: "Sarah Ahmed", email: "sarah.ahmed@company.com", role: "HR", status: "Active" },
  { id: 3, name: "Ali Raza", email: "ali.raza@company.com", role: "Accounts", status: "Active" },
  { id: 4, name: "Fatima Shah", email: "fatima.shah@company.com", role: "HR", status: "Inactive" },
  { id: 5, name: "Hassan Malik", email: "hassan.malik@company.com", role: "Accounts", status: "Active" },
];

export default function UserManagement() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [selectedRole, setSelectedRole] = useState("All Roles");
  const [selectedStatus, setSelectedStatus] = useState("All Status");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredUsers = users.filter((user) => {
    const matchesSearch = user.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          user.email.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesRole = selectedRole === "All Roles" || user.role === selectedRole;
    const matchesStatus = selectedStatus === "All Status" || user.status === selectedStatus;
    
    return matchesSearch && matchesRole && matchesStatus;
  });

  const editUser = (user: any) => {
    setSelectedUser(user);
    setIsEditModalOpen(true);
  };

  return (
    <>
      <Header
        title="User Management"
        actions={
          <>
            <ExportButton
              onExport={() =>
                exportTable({
                  fileName: "Users.xlsx",
                  sheetName: "Users",
                  title: "User Management",
                  headers: ["Name", "Email", "Role", "Status"],
                  rows: filteredUsers.map((u) => [u.name, u.email, u.role, u.status]),
                })
              }
            />
            <Button variant="primary" size="md" onClick={() => setIsModalOpen(true)}>
              <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
              Create User
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-8">
        <div className="bg-white rounded-lg border border-slate-200">
          <div className="p-6 border-b border-slate-200">
            <div className="flex items-center gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" strokeWidth={1.5} />
                <input
                  type="text"
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
                />
              </div>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option>All Roles</option>
                <option>Super Admin</option>
                <option>HR</option>
                <option>Accounts</option>
              </select>
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              >
                <option>All Status</option>
                <option>Active</option>
                <option>Inactive</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Name</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Email</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Role</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Status</th>
                  <th className="text-left px-6 py-3 text-sm text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 text-sm text-slate-900">{user.name}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{user.email}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{user.role}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded text-xs ${
                          user.status === "Active"
                            ? "bg-green-50 text-green-700"
                            : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {user.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Button variant="ghost" size="sm" onClick={() => editUser(user)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-8 bg-white rounded-lg border border-slate-200 p-6">
          <h3 className="text-base mb-6 text-slate-900">Role Permissions</h3>
          <div className="space-y-6">
            <div>
              <h4 className="text-sm text-slate-900 mb-3">Super Admin</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {["Users", "Employees", "Attendance", "Payroll", "Expenses", "Cashflow", "Settings"].map((perm) => (
                  <label key={perm} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                    <span>{perm}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">HR</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {["Employees", "Attendance", "Documents"].map((perm) => (
                  <label key={perm} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                    <span>{perm}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="pt-4 border-t border-slate-200">
              <h4 className="text-sm text-slate-900 mb-3">Accounts</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {["Attendance (Read)", "Payroll", "Expenses", "Cashflow"].map((perm) => (
                  <label key={perm} className="flex items-center gap-2 text-sm text-slate-600">
                    <input type="checkbox" defaultChecked className="rounded border-slate-300" />
                    <span>{perm}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Create User" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Name</label>
            <input
              type="text"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Enter full name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Email</label>
            <input
              type="email"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="email@company.com"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Role</label>
            <select className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent">
              <option>Select role</option>
              <option>Super Admin</option>
              <option>HR</option>
              <option>Accounts</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Password</label>
            <input
              type="password"
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
              placeholder="Create password"
            />
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Create User
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isEditModalOpen} onClose={() => setIsEditModalOpen(false)} title="Edit User" size="md">
        <form className="space-y-4">
          <div>
            <label className="block text-sm text-slate-700 mb-1">Name</label>
            <input
              type="text"
              defaultValue={selectedUser?.name}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="Enter full name"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Email</label>
            <input
              type="email"
              defaultValue={selectedUser?.email}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              placeholder="email@company.com"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Role</label>
            <select
              defaultValue={selectedUser?.role}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>Super Admin</option>
              <option>HR</option>
              <option>Accounts</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-700 mb-1">Status</label>
            <select
              defaultValue={selectedUser?.status}
              className="w-full px-4 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            >
              <option>Active</option>
              <option>Inactive</option>
            </select>
          </div>
          <div className="flex items-center gap-3 pt-4">
            <Button variant="primary" size="md" className="flex-1">
              Update User
            </Button>
            <Button variant="secondary" size="md" onClick={() => setIsEditModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
